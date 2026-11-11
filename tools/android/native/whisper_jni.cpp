// JNI для whisper.cpp: app.dsp.phone.WhisperNative. Контекст один на модель; whisper_full не потокобезопасен — Kotlin вызывает по одному.
// Текст сегментов отдаётся байтами UTF-8 (Kotlin декодирует с заменой): NewStringUTF на невалидной последовательности роняет ART.
#include <jni.h>
#include <android/log.h>
#include <atomic>
#include <cstring>
#include <string>
#include <vector>
#include "whisper.h"
#include "ggml-backend.h"

#define TAG "dsp-whisper"
#define JNIF(ret, name) extern "C" JNIEXPORT ret JNICALL Java_app_dsp_phone_WhisperNative_##name

static void log_cb(enum ggml_log_level level, const char* text, void*) {
    int pr = level == GGML_LOG_LEVEL_ERROR ? ANDROID_LOG_ERROR : level == GGML_LOG_LEVEL_WARN ? ANDROID_LOG_WARN : ANDROID_LOG_INFO;
    __android_log_print(pr, TAG, "%s", text);
}

// Устройства ggml, видимые этой сборкой: «CPU», «OpenCL» … — по ним Kotlin видит, что GPU действительно подключён.
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

JNIF(jstring, systemInfo)(JNIEnv* env, jclass) { return env->NewStringUTF(whisper_print_system_info()); }

JNIF(jlong, init)(JNIEnv* env, jclass, jstring path, jboolean gpu, jboolean flash) {
    whisper_log_set(log_cb, nullptr);
    const char* p = env->GetStringUTFChars(path, nullptr);
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = gpu;
    cp.flash_attn = flash;
    whisper_context* ctx = whisper_init_from_file_with_params(p, cp);
    env->ReleaseStringUTFChars(path, p);
    return (jlong)(intptr_t)ctx;
}

JNIF(void, free)(JNIEnv*, jclass, jlong h) { if (h) whisper_free((whisper_context*)(intptr_t)h); }

JNIF(jboolean, isMultilingual)(JNIEnv*, jclass, jlong h) { return h ? whisper_is_multilingual((whisper_context*)(intptr_t)h) : 0; }

struct Run {
    JNIEnv* env;
    jobject sink;
    jmethodID seg, aborted;
    whisper_context* ctx;
    int sent = 0;
    bool stop = false;
};

static void on_segment(whisper_context* ctx, whisper_state*, int n_new, void* u) {
    Run* r = (Run*)u;
    int n = whisper_full_n_segments(ctx);
    for (int i = n - n_new; i < n; i++) {
        if (i < 0) continue;
        const char* t = whisper_full_get_segment_text(ctx, i);
        size_t len = t ? strlen(t) : 0;
        jbyteArray b = r->env->NewByteArray((jsize)len);
        if (len) r->env->SetByteArrayRegion(b, 0, (jsize)len, (const jbyte*)t);
        // t0 / t1 — в сотых долях секунды, как отдаёт whisper.cpp
        r->env->CallVoidMethod(r->sink, r->seg, (jlong)whisper_full_get_segment_t0(ctx, i), (jlong)whisper_full_get_segment_t1(ctx, i), b,
                               (jfloat)whisper_full_get_segment_no_speech_prob(ctx, i));
        r->env->DeleteLocalRef(b);
        r->sent++;
        if (r->env->ExceptionCheck()) { r->env->ExceptionClear(); r->stop = true; }
    }
}

static bool on_abort(void* u) {
    Run* r = (Run*)u;
    if (r->stop) return true;
    bool a = r->env->CallBooleanMethod(r->sink, r->aborted);
    if (r->env->ExceptionCheck()) { r->env->ExceptionClear(); a = true; }
    if (a) r->stop = true;
    return a;
}

// Возвращает число сегментов (>= 0) или отрицательный код: -1 нет контекста, -2 пустой звук, -3 ошибка whisper_full, -4 прервано.
// beam <= 1 — жадный разбор (быстро), иначе поиск пучком (точнее, медленнее). fast — урезать окно энкодера под длину звука (быстрее, хуже на длинных фразах).
JNIF(jint, transcribe)(JNIEnv* env, jclass, jlong h, jfloatArray pcm, jstring lang, jboolean translate, jint threads, jstring prompt, jint beam,
                jfloat temperature, jboolean noContext, jboolean fast, jboolean suppressNst, jobject sink) {
    whisper_context* ctx = (whisper_context*)(intptr_t)h;
    if (!ctx) return -1;
    jsize n = env->GetArrayLength(pcm);
    if (n <= 0) return -2;
    std::vector<float> samples(n);
    env->GetFloatArrayRegion(pcm, 0, n, samples.data());

    whisper_full_params wp = whisper_full_default_params(beam > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
    if (beam > 1) wp.beam_search.beam_size = beam;
    wp.n_threads = threads > 0 ? threads : 4;
    wp.print_progress = wp.print_realtime = wp.print_timestamps = wp.print_special = false;
    wp.translate = translate;
    wp.no_context = noContext;
    wp.suppress_nst = suppressNst;
    wp.temperature = temperature;
    if (fast) {
        // окно энкодера по длине звука (1500 = 30 с): как в примере stream whisper.cpp
        int ac = (int)(((double)n / 16000.0) * 50.0) + 64;
        wp.audio_ctx = ac < 1500 ? ac : 0;
    }
    const char* lg = lang ? env->GetStringUTFChars(lang, nullptr) : nullptr;
    wp.language = (lg && *lg) ? lg : "auto";
    wp.detect_language = !(lg && *lg && strcmp(lg, "auto") != 0);
    const char* pr = prompt ? env->GetStringUTFChars(prompt, nullptr) : nullptr;
    wp.initial_prompt = (pr && *pr) ? pr : nullptr;

    jclass cls = env->GetObjectClass(sink);
    Run run{env, sink, env->GetMethodID(cls, "segment", "(JJ[BF)V"), env->GetMethodID(cls, "aborted", "()Z"), ctx};
    wp.new_segment_callback = on_segment;
    wp.new_segment_callback_user_data = &run;
    wp.abort_callback = on_abort;
    wp.abort_callback_user_data = &run;

    int rc = whisper_full(ctx, wp, samples.data(), (int)samples.size());
    if (lg) env->ReleaseStringUTFChars(lang, lg);
    if (pr) env->ReleaseStringUTFChars(prompt, pr);
    if (run.stop) return -4;
    return rc == 0 ? run.sent : -3;
}
