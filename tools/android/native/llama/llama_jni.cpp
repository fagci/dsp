// JNI для llama.cpp: app.dsp.phone.LlamaNative. Один контекст на модель; генерация без состояния (история приходит целиком, KV-кэш сбрасывается),
// вызывать по одному. Куски текста уходят байтами UTF-8 и только по границам символов: токен кириллицы часто режет символ пополам.
#include <jni.h>
#include <android/log.h>
#include <algorithm>
#include <cstring>
#include <string>
#include <vector>
#include "llama.h"
#include "ggml-backend.h"

#define TAG "dsp-llama"
#define JNIF(ret, name) extern "C" JNIEXPORT ret JNICALL Java_app_dsp_phone_LlamaNative_##name

static void log_cb(enum ggml_log_level level, const char* text, void*) {
    int pr = level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : level == GGML_LOG_LEVEL_WARN ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    __android_log_print(pr, TAG, "%s", text);
}

struct Llm {
    llama_model* model = nullptr;
    llama_context* ctx = nullptr;
    const llama_vocab* vocab = nullptr;
    int n_ctx = 0;
    int n_batch = 0;
};

// Длина самого длинного префикса, не обрывающегося посреди многобайтового символа UTF-8.
static size_t utf8_complete(const std::string& s) {
    size_t n = s.size(), i = n;
    int back = 0;
    while (i > 0 && back < 4) {
        unsigned char c = (unsigned char)s[i - 1];
        if ((c & 0xC0) == 0x80) { i--; back++; continue; }                 // продолжение символа — идём к его началу
        size_t need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
        return (n - (i - 1)) >= need ? n : i - 1;                          // начало символа: хватает ли байтов до конца
    }
    return n;
}

JNIF(jstring, backends)(JNIEnv* env, jclass) {
    std::string s;
    for (size_t i = 0; i < ggml_backend_dev_count(); i++) {
        ggml_backend_dev_t d = ggml_backend_dev_get(i);
        if (!s.empty()) s += ";";
        s += (ggml_backend_dev_type(d) == GGML_BACKEND_DEVICE_TYPE_GPU ? "GPU:" : ggml_backend_dev_type(d) == GGML_BACKEND_DEVICE_TYPE_IGPU ? "IGPU:" : "CPU:");
        s += ggml_backend_dev_name(d);
        s += "|";
        s += ggml_backend_dev_description(d);
    }
    return env->NewStringUTF(s.c_str());
}

JNIF(jstring, systemInfo)(JNIEnv* env, jclass) { return env->NewStringUTF(llama_print_system_info()); }

// gpuLayers: 0 — только CPU; < 0 — все слои на GPU. Возвращает указатель или 0.
JNIF(jlong, init)(JNIEnv* env, jclass, jstring path, jint nCtx, jint gpuLayers, jint threads, jboolean flash, jboolean mmap) {
    static bool inited = false;
    if (!inited) { llama_log_set(log_cb, nullptr); llama_backend_init(); inited = true; }
    const char* p = env->GetStringUTFChars(path, nullptr);
    llama_model_params mp = llama_model_default_params();
    mp.n_gpu_layers = gpuLayers;
    mp.use_mmap = mmap;
    llama_model* m = llama_model_load_from_file(p, mp);
    env->ReleaseStringUTFChars(path, p);
    if (!m) return 0;
    llama_context_params cp = llama_context_default_params();
    cp.n_ctx = nCtx > 0 ? nCtx : 4096;
    cp.n_batch = 512;
    cp.n_ubatch = 512;
    cp.n_threads = threads > 0 ? threads : 4;
    cp.n_threads_batch = cp.n_threads;
    cp.flash_attn_type = flash ? LLAMA_FLASH_ATTN_TYPE_ENABLED : LLAMA_FLASH_ATTN_TYPE_DISABLED;
    cp.no_perf = false;
    llama_context* c = llama_init_from_model(m, cp);
    if (!c) { llama_model_free(m); return 0; }
    Llm* l = new Llm();
    l->model = m; l->ctx = c; l->vocab = llama_model_get_vocab(m);
    l->n_ctx = (int)llama_n_ctx(c); l->n_batch = (int)cp.n_batch;
    return (jlong)(intptr_t)l;
}

JNIF(void, free)(JNIEnv*, jclass, jlong h) {
    Llm* l = (Llm*)(intptr_t)h; if (!l) return;
    if (l->ctx) llama_free(l->ctx);
    if (l->model) llama_model_free(l->model);
    delete l;
}

// «Описание; размер в байтах; обучающий контекст; контекст сейчас» — одной строкой через «|»
JNIF(jstring, describe)(JNIEnv* env, jclass, jlong h) {
    Llm* l = (Llm*)(intptr_t)h; if (!l) return env->NewStringUTF("");
    char buf[256]; llama_model_desc(l->model, buf, sizeof buf);
    std::string s = std::string(buf) + "|" + std::to_string((unsigned long long)llama_model_size(l->model)) + "|" + std::to_string(llama_model_n_ctx_train(l->model)) + "|" + std::to_string(l->n_ctx);
    return env->NewStringUTF(s.c_str());
}

// Шаблон диалога самой модели: роли и тексты → готовый запрос (UTF-8). null — у модели нет шаблона или он не поддержан.
JNIF(jbyteArray, applyTemplate)(JNIEnv* env, jclass, jlong h, jobjectArray roles, jobjectArray contents, jboolean addAss) {
    Llm* l = (Llm*)(intptr_t)h; if (!l) return nullptr;
    const char* tmpl = llama_model_chat_template(l->model, nullptr);
    if (!tmpl) return nullptr;
    jsize n = env->GetArrayLength(roles);
    std::vector<std::string> rs(n), cs(n);
    std::vector<llama_chat_message> msgs(n);
    size_t total = 0;
    for (jsize i = 0; i < n; i++) {
        jstring r = (jstring)env->GetObjectArrayElement(roles, i), c = (jstring)env->GetObjectArrayElement(contents, i);
        const char* rp = env->GetStringUTFChars(r, nullptr); rs[i] = rp; env->ReleaseStringUTFChars(r, rp);
        const char* cp = env->GetStringUTFChars(c, nullptr); cs[i] = cp; env->ReleaseStringUTFChars(c, cp);
        env->DeleteLocalRef(r); env->DeleteLocalRef(c);
        msgs[i] = {rs[i].c_str(), cs[i].c_str()};
        total += rs[i].size() + cs[i].size();
    }
    std::vector<char> buf(total * 2 + 1024);
    int32_t len = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), addAss, buf.data(), (int32_t)buf.size());
    if (len > (int32_t)buf.size()) { buf.resize(len + 16); len = llama_chat_apply_template(tmpl, msgs.data(), msgs.size(), addAss, buf.data(), (int32_t)buf.size()); }
    if (len < 0) return nullptr;
    jbyteArray out = env->NewByteArray(len);
    env->SetByteArrayRegion(out, 0, len, (const jbyte*)buf.data());
    return out;
}

// Число токенов запроса (для проверки длины до генерации)
JNIF(jint, countTokens)(JNIEnv* env, jclass, jlong h, jbyteArray text) {
    Llm* l = (Llm*)(intptr_t)h; if (!l) return -1;
    jsize n = env->GetArrayLength(text);
    std::string s(n, '\0'); env->GetByteArrayRegion(text, 0, n, (jbyte*)s.data());
    int r = llama_tokenize(l->vocab, s.data(), (int32_t)s.size(), nullptr, 0, true, true);
    return r < 0 ? -r : r;
}

// Возвращает число сгенерированных токенов (>= 0) или код: -1 нет модели, -2 запрос не влезает в контекст, -3 ошибка decode, -5 ошибка токенизации.
// sink.token(byte[]): Boolean — false останавливает; sink.cancelled(): Boolean — опрашивается на каждом токене.
JNIF(jint, generate)(JNIEnv* env, jclass, jlong h, jbyteArray prompt, jint maxTokens, jfloat temp, jint topK, jfloat topP, jfloat minP, jfloat repeat, jint seed, jobject sink) {
    Llm* l = (Llm*)(intptr_t)h; if (!l) return -1;
    jclass cls = env->GetObjectClass(sink);
    jmethodID mTok = env->GetMethodID(cls, "token", "([B)Z"), mCan = env->GetMethodID(cls, "cancelled", "()Z");

    jsize pn = env->GetArrayLength(prompt);
    std::string ps(pn, '\0'); env->GetByteArrayRegion(prompt, 0, pn, (jbyte*)ps.data());
    int nt = -llama_tokenize(l->vocab, ps.data(), (int32_t)ps.size(), nullptr, 0, true, true);
    if (nt <= 0) return -5;
    std::vector<llama_token> toks(nt);
    if (llama_tokenize(l->vocab, ps.data(), (int32_t)ps.size(), toks.data(), nt, true, true) < 0) return -5;
    if (nt >= l->n_ctx - 4) return -2;

    llama_memory_clear(llama_get_memory(l->ctx), true);                    // без состояния: диалог приходит целиком

    llama_sampler_chain_params sp = llama_sampler_chain_default_params();
    llama_sampler* smpl = llama_sampler_chain_init(sp);
    if (repeat > 1.0f) llama_sampler_chain_add(smpl, llama_sampler_init_penalties(64, repeat, 0.0f, 0.0f));
    if (temp <= 0.0f) llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
    else {
        if (topK > 0) llama_sampler_chain_add(smpl, llama_sampler_init_top_k(topK));
        if (topP < 1.0f) llama_sampler_chain_add(smpl, llama_sampler_init_top_p(topP, 1));
        if (minP > 0.0f) llama_sampler_chain_add(smpl, llama_sampler_init_min_p(minP, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(temp));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist(seed > 0 ? (uint32_t)seed : (uint32_t)LLAMA_DEFAULT_SEED));
    }

    int rc = 0, gen = 0;
    // запрос — кусками по n_batch
    for (int i = 0; i < nt && rc == 0; i += l->n_batch) {
        int n = std::min(l->n_batch, nt - i);
        llama_batch b = llama_batch_get_one(toks.data() + i, n);
        if (llama_decode(l->ctx, b) != 0) rc = -3;
        if (rc == 0 && env->CallBooleanMethod(sink, mCan)) { llama_sampler_free(smpl); return 0; }
    }
    std::string pend;
    int limit = std::min(maxTokens > 0 ? (int)maxTokens : 1 << 30, l->n_ctx - nt - 1);
    while (rc == 0 && gen < limit) {
        llama_token t = llama_sampler_sample(smpl, l->ctx, -1);
        if (llama_vocab_is_eog(l->vocab, t)) break;
        char piece[256];
        int pl = llama_token_to_piece(l->vocab, t, piece, sizeof piece, 0, false);
        if (pl > 0) pend.append(piece, pl);
        gen++;
        size_t ok = utf8_complete(pend);
        if (ok > 0) {
            jbyteArray b = env->NewByteArray((jsize)ok);
            env->SetByteArrayRegion(b, 0, (jsize)ok, (const jbyte*)pend.data());
            jboolean cont = env->CallBooleanMethod(sink, mTok, b);
            env->DeleteLocalRef(b);
            pend.erase(0, ok);
            if (env->ExceptionCheck()) { env->ExceptionClear(); break; }
            if (!cont) break;
        }
        if (env->CallBooleanMethod(sink, mCan)) break;
        llama_batch nb = llama_batch_get_one(&t, 1);
        if (llama_decode(l->ctx, nb) != 0) { rc = -3; break; }
    }
    if (rc == 0 && !pend.empty()) {                                        // хвост, оборвавшийся посреди символа: отдаём как есть (Kotlin заменит битое)
        jbyteArray b = env->NewByteArray((jsize)pend.size());
        env->SetByteArrayRegion(b, 0, (jsize)pend.size(), (const jbyte*)pend.data());
        env->CallBooleanMethod(sink, mTok, b);
        env->DeleteLocalRef(b);
    }
    llama_sampler_free(smpl);
    return rc == 0 ? gen : rc;
}

// Время разбора запроса и генерации: {мс запроса, токенов запроса, мс генерации, токенов}
JNIF(jdoubleArray, perf)(JNIEnv* env, jclass, jlong h) {
    Llm* l = (Llm*)(intptr_t)h;
    jdoubleArray out = env->NewDoubleArray(4);
    if (!l) return out;
    llama_perf_context_data d = llama_perf_context(l->ctx);
    double v[4] = {d.t_p_eval_ms, (double)d.n_p_eval, d.t_eval_ms, (double)d.n_eval};
    env->SetDoubleArrayRegion(out, 0, 4, v);
    llama_perf_context_reset(l->ctx);
    return out;
}
