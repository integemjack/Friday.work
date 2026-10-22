// 音色克隆：把一段参考录音 + 底稿文字提成一个 CosyVoice3 音色（prompt_speech gguf）。
// 上游 cosyvoice.cpp 的 ONNX 前端（speech tokenizer 认语音 token、campplus 认说话人向量）；
// Friday.Powers 之前把它裁掉了（音色离线生成随包发），v0.5 起编回来做零样本克隆。
//
// 惰性加载：第一次 clone() 才加载两个 ONNX 会话（speech tokenizer int8 有 232MB，加载要几秒），
// 不用克隆的 serve 一点内存都不多占。线程安全：clone 里只碰前端自己的会话（ORT 会话可并发，
// 但克隆是稀有操作，加锁串行最省心）。
#pragma once

#include <mutex>
#include <string>

struct cosyvoice_frontend_context;

namespace voice {

class VoiceCloner {
public:
    /// 两个 ONNX 的路径；构造后 configure 一次，clone 时才真正加载
    void configure(const std::string& speechTokenizer, const std::string& campplus);
    bool available() const { return !m_tokenizer.empty() && !m_campplus.empty(); }
    const std::string& tokenizerPath() const { return m_tokenizer; }

    /// speech16k：16 kHz 单声道 float；promptText：这段录音说了什么（底稿）；
    /// outPath：输出的音色 gguf。失败时 *error 有说明。
    bool clone(const float* speech16k, size_t len, const std::string& promptText, const std::string& outPath, std::string* error);

private:
    bool ensureLoaded(std::string* error);

    std::string m_tokenizer, m_campplus;
    cosyvoice_frontend_context* m_ctx = nullptr;
    std::mutex m_mutex;
};

} // namespace voice
