#include "VoiceCloner.h"

#include "AudioIO.h"
#include "Log.h"

#include "cosyvoice.h"
#include "cosyvoice-frontend.h"
#include "cosyvoice-lowlevel.h"

#include <chrono>
#include <filesystem>
#include <vector>

namespace fs = std::filesystem;

namespace voice {

namespace {
double since(std::chrono::steady_clock::time_point t)
{
    return std::chrono::duration<double>(std::chrono::steady_clock::now() - t).count();
}
} // namespace

void VoiceCloner::configure(const std::string& speechTokenizer, const std::string& campplus)
{
    m_tokenizer = speechTokenizer;
    m_campplus = campplus;
}

bool VoiceCloner::ensureLoaded(std::string* error)
{
    if (m_ctx)
        return true;
    if (m_tokenizer.empty() || m_campplus.empty()) {
        if (error)
            *error = "没配克隆前端模型（speech tokenizer / campplus）";
        return false;
    }
    const auto started = std::chrono::steady_clock::now();
    VLOG_INFO("加载克隆前端：%s + %s", m_tokenizer.c_str(), m_campplus.c_str());
    m_ctx = cosyvoice_frontend_load_from_files(m_tokenizer.c_str(), m_campplus.c_str());
    if (!m_ctx) {
        if (error)
            *error = "克隆前端加载失败（speech tokenizer / campplus 的 ONNX 打不开？）";
        return false;
    }
    VLOG_INFO("克隆前端就绪：%.1f 秒", since(started));
    return true;
}

bool VoiceCloner::clone(const float* speech16k, size_t len, const std::string& promptText, const std::string& outPath,
                        std::string* error)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    if (!ensureLoaded(error))
        return false;
    // 前端要 16 kHz（语音 token）和 24 kHz（说话人向量、mel）两份
    std::vector<float> pcm24k;
    StreamResampler to24k(kSampleRate, 24000);
    to24k.process(speech16k, len, pcm24k);
    const auto started = std::chrono::steady_clock::now();
    cosyvoice_prompt_speech_t speech = cosyvoice_frontend_prompt_speech_direct(
        m_ctx, const_cast<float*>(speech16k), uint32_t(len), pcm24k.data(), uint32_t(pcm24k.size()), promptText.c_str());
    if (!speech) {
        if (error)
            *error = "提取音色失败（录音太短、没声音，或底稿和录音对不上？）";
        return false;
    }
    const fs::path out = fs::u8path(outPath);
    std::error_code ec;
    fs::create_directories(out.parent_path(), ec);
    const bool saved = cosyvoice_prompt_speech_save_to_file(speech, out.u8string().c_str());
    cosyvoice_prompt_speech_free(speech);
    if (!saved) {
        if (error)
            *error = "写不了音色文件：" + outPath;
        return false;
    }
    VLOG_INFO("音色克隆：%.1f 秒录音 → %s（%.1f KB），用时 %.1f 秒", len / double(kSampleRate), outPath.c_str(),
              fs::file_size(out, ec) / 1024.0, since(started));
    return true;
}

} // namespace voice
