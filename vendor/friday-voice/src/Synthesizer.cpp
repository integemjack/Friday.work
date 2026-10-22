#include "Synthesizer.h"

#include "Log.h"

#include "cosyvoice.h"
#include "cosyvoice-lowlevel.h"   // 要在 cosyvoice.h 之后

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <mutex>

namespace fs = std::filesystem;

namespace voice {

namespace {

double since(std::chrono::steady_clock::time_point t)
{
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - t).count();
}

} // namespace

Synthesizer::Synthesizer(const Backend& backend) : m_backend(backend)
{
}

Synthesizer::~Synthesizer()
{
    for (auto& [name, v] : m_voices) {
        if (v.tts)
            cosyvoice_tts_context_free(v.tts);
        if (v.prompt)
            cosyvoice_prompt_free(v.prompt);
        if (v.speech)
            cosyvoice_prompt_speech_free(v.speech);
    }
    if (m_ctx)
        cosyvoice_free(m_ctx);
}

bool Synthesizer::load(const std::string& modelPath, const std::string& voicesDir, std::string* error, const std::string& userVoicesDir)
{
    const auto started = std::chrono::steady_clock::now();
    // cosyvoice 会接管传进去的 backend（用完自己释放），所以在选好的设备上另开一个
    ggml_backend_t backend = nullptr;
    if (m_backend.gpu())
        backend = ggml_backend_dev_init(ggml_backend_get_device(m_backend.gpu()), nullptr);
    if (!backend)
        backend = ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);

    cosyvoice_context_params_v4_t params {};
    cosyvoice_init_default_context_params(&params.base_params.base_params.base_params);
    params.base_params.base_params.n_workers = 1;
    params.base_params.dit_kv_cache_type =
        COSYVOICE_MAKE_SEPARATE_KV_CACHE(COSYVOICE_KV_CACHE_TYPE_Q8_0, COSYVOICE_KV_CACHE_TYPE_Q4_0, COSYVOICE_KV_CACHE_TYPE_Q8_0);
    params.base_params.dit_allow_kv_cache_fallback = true;
    params.strict_seed_mode = false;   // 不要求同一种子逐位相同，省一次预填充
    // Metal 上 LLM 的 flash attention 算错（2026-10-08，M1 + ggml v0.26.0：念出来是乱语、一直念到长度上限，KV 缓存换 F16 也一样；
    // 关掉就对了）。flow 的 flash attention 没问题，留着（全关更慢）
    if (m_backend.isMetal())
        params.base_params.base_params.base_params.llm_use_flash_attn = false;
    m_ctx = cosyvoice_load_from_file_ext(modelPath.c_str(), &params.base_params.base_params.base_params, backend,
                                         uint32_t(m_backend.threads()), COSYVOICE_CONTEXT_PARAMS_V4_VERSION);
    if (!m_ctx) {
        if (error)
            *error = "打不开合成模型：" + modelPath;
        return false;
    }
    m_path = modelPath;
    m_sampleRate = int(cosyvoice_get_sample_rate(m_ctx));

    std::error_code ec;
    if (!scanVoices(voicesDir, false, error))
        return false;
    if (!userVoicesDir.empty() && fs::exists(fs::u8path(userVoicesDir), ec)) {
        std::string userError;
        scanVoices(userVoicesDir, true, &userError);   // 用户音色坏了不拖累启动，跳过就行
        if (!userError.empty())
            VLOG_WARN("用户音色目录扫出了问题（忽略）：%s", userError.c_str());
    }
    if (m_voices.empty()) {
        if (error)
            *error = "没有可用的音色（" + voicesDir + " 里要有 <名字>.gguf）";
        return false;
    }
    m_defaultVoice = m_voices.count("default") ? "default" : m_voices.begin()->first;
    VLOG_INFO("CosyVoice3 已加载：%s（%d Hz，%d 个音色（其中 %d 个用户克隆），每块 %u 个语音 token，%.1f 秒）", modelPath.c_str(), m_sampleRate,
              int(m_voices.size()), int(std::count_if(m_voices.begin(), m_voices.end(), [](const auto& v) { return v.second.user; })),
              cosyvoice_get_chunk_tokens(m_ctx), since(started));
    return true;
}

bool Synthesizer::scanVoices(const std::string& dir, bool user, std::string* error)
{
    if (dir.empty())
        return true;
    std::error_code ec;
    for (const auto& entry : fs::directory_iterator(fs::u8path(dir), ec)) {
        if (!entry.is_regular_file() || entry.path().extension() != ".gguf")
            continue;
        const std::string name = entry.path().stem().u8string();
        if (m_voices.count(name))
            continue;   // 用户音色和内置同名：内置优先
        Voice v;
        v.user = user;
        v.file = entry.path().u8string();
        v.speech = cosyvoice_prompt_speech_load_from_file(entry.path().u8string().c_str());
        if (v.speech)
            v.prompt = cosyvoice_prompt_init_from_prompt_speech(m_ctx, v.speech);
        if (v.prompt)
            v.tts = cosyvoice_tts_context_new(m_ctx, v.prompt);
        if (!v.tts) {
            VLOG_WARN("音色 %s 加载失败，跳过", entry.path().u8string().c_str());
            if (v.prompt)
                cosyvoice_prompt_free(v.prompt);
            if (v.speech)
                cosyvoice_prompt_speech_free(v.speech);
            continue;
        }
        m_voices[name] = v;
    }
    if (ec && error)
        *error = "打不开音色目录：" + dir;
    return !ec;
}

void Synthesizer::setChunkTokens(unsigned tokens)
{
    if (m_ctx && tokens > 0)
        cosyvoice_set_chunk_tokens(m_ctx, tokens);
}

unsigned Synthesizer::chunkTokens() const
{
    return m_ctx ? cosyvoice_get_chunk_tokens(m_ctx) : 0;
}

std::vector<std::string> Synthesizer::voices() const
{
    std::vector<std::string> names;
    for (const auto& [name, v] : m_voices)
        names.push_back(name);
    return names;
}

std::vector<std::string> Synthesizer::userVoices() const
{
    std::vector<std::string> names;
    for (const auto& [name, v] : m_voices) {
        if (v.user)
            names.push_back(name);
    }
    return names;
}

bool Synthesizer::isUserVoice(const std::string& voice) const
{
    const auto it = m_voices.find(voice);
    return it != m_voices.end() && it->second.user;
}

bool Synthesizer::addVoiceFile(const std::string& ggufPath, bool user, std::string* error)
{
    if (!m_ctx) {
        if (error)
            *error = "合成模型没加载";
        return false;
    }
    const fs::path path = fs::u8path(ggufPath);
    const std::string name = path.stem().u8string();
    std::lock_guard<std::mutex> lock(m_mutex);   // 和正在念的互斥：等它念完再加
    if (m_voices.count(name)) {
        if (error)
            *error = "已有同名音色：" + name;
        return false;
    }
    Voice v;
    v.user = user;
    v.file = path.u8string();
    v.speech = cosyvoice_prompt_speech_load_from_file(path.u8string().c_str());
    if (v.speech)
        v.prompt = cosyvoice_prompt_init_from_prompt_speech(m_ctx, v.speech);
    if (v.prompt)
        v.tts = cosyvoice_tts_context_new(m_ctx, v.prompt);
    if (!v.tts) {
        if (v.prompt)
            cosyvoice_prompt_free(v.prompt);
        if (v.speech)
            cosyvoice_prompt_speech_free(v.speech);
        if (error)
            *error = "音色加载失败（gguf 坏了？）:" + name;
        return false;
    }
    m_voices[name] = v;
    VLOG_INFO("音色已注册：%s（%s）", name.c_str(), ggufPath.c_str());
    return true;
}

bool Synthesizer::removeVoice(const std::string& name, std::string* error)
{
    std::lock_guard<std::mutex> lock(m_mutex);   // 正在念就等它念完
    const auto it = m_voices.find(name);
    if (it == m_voices.end()) {
        if (error)
            *error = "没有这个音色：" + name;
        return false;
    }
    if (!it->second.user) {
        if (error)
            *error = "内置音色删不掉：" + name;
        return false;
    }
    Voice v = it->second;
    m_voices.erase(it);
    if (m_defaultVoice == name)
        m_defaultVoice = m_voices.count("default") ? "default" : (m_voices.empty() ? std::string() : m_voices.begin()->first);
    if (v.tts)
        cosyvoice_tts_context_free(v.tts);
    if (v.prompt)
        cosyvoice_prompt_free(v.prompt);
    if (v.speech)
        cosyvoice_prompt_speech_free(v.speech);
    std::error_code ec;
    if (!v.file.empty())
        fs::remove(fs::u8path(v.file), ec);   // gguf 文件一并删掉（下次启动不再加载）
    VLOG_INFO("音色已删：%s（%s）", name.c_str(), ec ? "文件没删掉" : "连文件一起删了");
    return true;
}

SpeakResult Synthesizer::speak(uint64_t owner, const std::string& text, const std::string& voice, float speed,
                               const std::string& instruction, const OnAudio& onAudio)
{
    SpeakResult result;
    if (!m_ctx) {
        result.error = "合成模型没加载";
        return result;
    }
    const auto it = m_voices.find(voice.empty() ? m_defaultVoice : voice);
    if (it == m_voices.end()) {
        result.error = "没有这个音色：" + voice;
        return result;
    }
    const auto queued = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(m_mutex);
    result.queuedSeconds = since(queued);
    {
        std::lock_guard<std::mutex> ownerLock(m_ownerMutex);
        m_owner = owner;
    }

    struct State {
        const OnAudio* onAudio;
        std::chrono::steady_clock::time_point started;
        size_t samples = 0;
        double firstAudio = 0;
        bool aborted = false;
    } state { &onAudio, std::chrono::steady_clock::now() };
    const auto callback = [](const float* audio, uint32_t count, void* user) -> bool {
        auto* s = static_cast<State*>(user);
        if (s->samples == 0)
            s->firstAudio = since(s->started);
        s->samples += count;
        if (!(*s->onAudio)(audio, count)) {
            s->aborted = true;
            return false;
        }
        return true;
    };
    const float rate = speed > 0.25f && speed < 4.0f ? speed : 1.0f;
    const bool ok = instruction.empty()
        ? cosyvoice_tts_zero_shot_stream(it->second.tts, text.c_str(), rate, callback, &state)
        : cosyvoice_tts_instruct_stream(it->second.tts, text.c_str(), instruction.c_str(), rate, callback, &state);
    {
        std::lock_guard<std::mutex> ownerLock(m_ownerMutex);
        m_owner = 0;
    }
    result.seconds = since(state.started);
    result.firstAudioSeconds = state.firstAudio;
    result.samples = state.samples;
    result.stopped = state.aborted || (!ok && state.samples > 0);
    result.ok = ok || result.stopped;
    if (!result.ok)
        result.error = "合成失败";
    return result;
}

void Synthesizer::stop(uint64_t owner)
{
    std::lock_guard<std::mutex> ownerLock(m_ownerMutex);
    if (m_ctx && owner != 0 && m_owner == owner)
        cosyvoice_request_stop(m_ctx);
}

} // namespace voice
