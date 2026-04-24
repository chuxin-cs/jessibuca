#ifdef EDITTIME
#undef __cplusplus
#define __cplusplus 201703L
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string>
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>
using namespace std;
using namespace emscripten;
typedef unsigned char u8;
typedef unsigned int u32;
#define PROP(name, type)         \
    type name;                   \
    val get##name() const        \
    {                            \
        return val(name);        \
    }                            \
    void set##name(val value)    \
    {                            \
        name = value.as<type>(); \
    }

extern "C"
{
#include <libavcodec/avcodec.h>
#include <libswresample/swresample.h>
}
class FFmpeg
{
public:
    AVCodec *codec = nullptr;
    AVCodecParserContext *parser = nullptr;
    AVCodecContext *dec_ctx = nullptr;
    AVFrame *frame;
    AVPacket *pkt;
    val jsObject;
    bool initialized = false;
    FFmpeg(val &&v) : jsObject(forward<val>(v))
    {
        pkt = av_packet_alloc();
        frame = av_frame_alloc();
    }
    void initCodec(enum AVCodecID id)
    {
        if (dec_ctx != nullptr)
        {
            clear();
        }
        codec = avcodec_find_decoder(id);
        parser = av_parser_init(codec->id);
        dec_ctx = avcodec_alloc_context3(codec);
    }
    void initCodec(enum AVCodecID id, string input)
    {
        initCodec(id);
        dec_ctx->extradata_size = input.length();
        dec_ctx->extradata = (u8 *)input.data();
        // // dec_ctx->extradata = (u8 *)malloc(dec_ctx->extradata_size);
        // // memcpy(dec_ctx->extradata, input.c_str(), dec_ctx->extradata_size);
        avcodec_open2(dec_ctx, codec, NULL);
        initialized = true;
    }
    virtual ~FFmpeg()
    {
        clear();
        av_frame_free(&frame);
        av_packet_free(&pkt);
    }
    virtual int decode(string input, u32 timestamp)
    {
        int ret = 0;
        pkt->data = (u8 *)(input.data());
        pkt->size = input.length();
        ret = avcodec_send_packet(dec_ctx, pkt);
        while (ret >= 0)
        {
            ret = avcodec_receive_frame(dec_ctx, frame);
            if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
                return 0;
            _decode(timestamp);
        }
        return 0;
    }
    virtual void _decode(u32 timestamp){};
    void clear()
    {
        av_parser_close(parser);
        parser = nullptr;
        avcodec_free_context(&dec_ctx);

        codec = nullptr;
        initialized = false;
    }
};

class FFmpegAudioDecoder : public FFmpeg
{
    SwrContext *au_convert_ctx = nullptr;
    u8 *out_buffer[2] = {nullptr, nullptr};
    int output_nb_samples = 0;
    int n_channel = 0;
    bool audioPlanarInitialized = false;
    uint64_t input_channel_layout = 0;
    uint64_t output_channel_layout = 0;
    int input_sample_rate = 0;
    int output_sample_rate = 0;
    AVSampleFormat input_sample_fmt = AV_SAMPLE_FMT_NONE;

public:
    PROP(sample_rate, int)
    //    struct SwrContext *au_convert_ctx = nullptr;
    FFmpegAudioDecoder(val &&v) : FFmpeg(move(v))
    {
        //        emscripten_log(0, "FFMpegAudioDecoder init");
    }
    ~FFmpegAudioDecoder()
    {
        clear();
        //        emscripten_log(0, "FFMpegAudioDecoder destory");
    }
    void clear()
    {
        if (au_convert_ctx)
        {
            swr_free(&au_convert_ctx);
        }
        if (out_buffer[0])
        {
            av_free(out_buffer[0]);
            out_buffer[0] = nullptr;
            out_buffer[1] = nullptr;
        }
        output_nb_samples = 0;
        audioPlanarInitialized = false;
        input_channel_layout = 0;
        output_channel_layout = 0;
        input_sample_rate = 0;
        output_sample_rate = 0;
        input_sample_fmt = AV_SAMPLE_FMT_NONE;
        FFmpeg::clear();
    }
    int decode(string input, u32 timestamp) override
    {
        u8 flag = (u8)input[0];
        u8 audioType = flag >> 4;
        if (initialized)
        {
            return FFmpeg::decode(input.substr(audioType == 10 ? 2 : 1), timestamp);
        }
        else
        {
            jsObject.call<void>("setAudioCodec", audioType);
            switch (audioType)
            {
            case 2:
                initCodec(AV_CODEC_ID_MP3);
                avcodec_open2(dec_ctx, codec, NULL);
                n_channel = dec_ctx->channels > 0 ? dec_ctx->channels : 2;
                initialized = true;
                break;
            case 10:
                if (!input[1])
                {
                    initCodec(AV_CODEC_ID_AAC, input.substr(2));
                    n_channel = 2;
                }
                break;
            case 7:
                initCodec(AV_CODEC_ID_PCM_ALAW);
                dec_ctx->channel_layout = AV_CH_LAYOUT_MONO;
                dec_ctx->sample_rate = 8000;
                dec_ctx->channels = 1;
                avcodec_open2(dec_ctx, codec, NULL);
                n_channel = 1;
                initialized = true;
                break;
            case 8:
                initCodec(AV_CODEC_ID_PCM_MULAW);
                dec_ctx->channel_layout = AV_CH_LAYOUT_MONO;
                dec_ctx->sample_rate = 8000;
                dec_ctx->channels = 1;
                avcodec_open2(dec_ctx, codec, NULL);
                n_channel = 1;
                initialized = true;
                break;
            default:
                //                emscripten_log(0, "audio type not support:%d", audioType);
                break;
            }
        }
        return 0;
    }
    void _decode(u32 timestamp) override
    {
        auto nb_samples = frame->nb_samples;
        auto output_channels = n_channel > 0 ? n_channel : (frame->channels > 0 ? frame->channels : 2);
        auto decoded_sample_rate = frame->sample_rate > 0 ? frame->sample_rate : dec_ctx->sample_rate;
        auto target_sample_rate = sample_rate > 0 ? sample_rate : decoded_sample_rate;
        auto decoded_channels = frame->channels > 0 ? frame->channels : (dec_ctx->channels > 0 ? dec_ctx->channels : output_channels);
        auto decoded_layout = frame->channel_layout ? frame->channel_layout : (dec_ctx->channel_layout ? dec_ctx->channel_layout : av_get_default_channel_layout(decoded_channels));
        auto target_layout = output_channels == 1 ? AV_CH_LAYOUT_MONO : AV_CH_LAYOUT_STEREO;
        auto frame_sample_fmt = (AVSampleFormat)frame->format;
        auto bytes_per_sample = av_get_bytes_per_sample(AV_SAMPLE_FMT_FLTP);

        if (!audioPlanarInitialized && output_channels > 0 && target_sample_rate > 0)
        {
            jsObject.call<void>("initAudioPlanar", output_channels, target_sample_rate);
            audioPlanarInitialized = true;
        }

        if (frame_sample_fmt == AV_SAMPLE_FMT_FLTP && target_sample_rate == decoded_sample_rate && decoded_layout == target_layout && decoded_channels == output_channels)
        {
            jsObject.call<void>("playAudioPlanar", int(frame->data), nb_samples, timestamp);
            return;
        }

        if (!au_convert_ctx || input_channel_layout != decoded_layout || output_channel_layout != target_layout ||
            input_sample_rate != decoded_sample_rate || output_sample_rate != target_sample_rate ||
            input_sample_fmt != frame_sample_fmt || nb_samples > output_nb_samples)
        {
            if (au_convert_ctx)
            {
                swr_free(&au_convert_ctx);
            }
            if (out_buffer[0])
            {
                av_free(out_buffer[0]);
                out_buffer[0] = nullptr;
                out_buffer[1] = nullptr;
            }

            input_channel_layout = decoded_layout;
            output_channel_layout = target_layout;
            input_sample_rate = decoded_sample_rate;
            output_sample_rate = target_sample_rate;
            input_sample_fmt = frame_sample_fmt;
            output_nb_samples = nb_samples;

            au_convert_ctx = swr_alloc_set_opts(NULL, target_layout, AV_SAMPLE_FMT_FLTP, target_sample_rate,
                                                decoded_layout, frame_sample_fmt, decoded_sample_rate,
                                                0, NULL);
            auto ret = swr_init(au_convert_ctx);
            if (ret < 0)
            {
                return;
            }
            auto out_buffer_size = av_samples_get_buffer_size(NULL, output_channels, output_nb_samples, AV_SAMPLE_FMT_FLTP, 0);
            auto buffer = (uint8_t *)av_malloc(out_buffer_size);
            out_buffer[0] = buffer;
            out_buffer[1] = output_channels == 2 ? buffer + (out_buffer_size / 2) : nullptr;
        }
        // // 转换
        auto ret = swr_convert(au_convert_ctx, out_buffer, nb_samples, (const uint8_t **)frame->data, nb_samples);
        while (ret > 0)
        {
            jsObject.call<void>("playAudioPlanar", int(&out_buffer), ret, timestamp);
            ret = swr_convert(au_convert_ctx, out_buffer, nb_samples, (const uint8_t **)frame->data, 0);
        }
    }
};
class FFmpegVideoDecoder : public FFmpeg
{
public:
    u32 videoWidth = 0;
    u32 videoHeight = 0;
    u32 y = 0;
    u32 u = 0;
    u32 v = 0;

    FFmpegVideoDecoder(val &&v) : FFmpeg(move(v))
    {
        //        emscripten_log(0, "FFMpegVideoDecoder init");
    }
    ~FFmpegVideoDecoder()
    {
        //        emscripten_log(0, "FFMpegVideoDecoder destory");
        if (y)
        {
            free((void *)y);
            y = 0;
        }
    }
    int decode(string data, u32 timestamp) override
    {
        int codec_id = ((int)data[0]) & 0x0F;
        if (((int)(data[0]) >> 4) == 1 && data[1] == 0)
        {
            //                emscripten_log(0, "codec = %d", codec_id);
            if (!initialized){
              jsObject.call<void>("setVideoCodec", codec_id);
              switch (codec_id)
              {
              case 7:
                  initCodec(AV_CODEC_ID_H264, data.substr(5));
                  break;
              case 12:
                  initCodec(AV_CODEC_ID_H265, data.substr(5));
                  break;
              default:
                  emscripten_log(0, "codec not support: %d", codec_id);
                  return -1;
              }
            }
        }
        else
        {
            return FFmpeg::decode(data.substr(5), timestamp);
        }
        return 0;
    }
    void _decode(u32 timestamp) override
    {
        if (videoWidth != frame->width || videoHeight != frame->height)
        {
            videoWidth = frame->width;
            videoHeight = frame->height;
            jsObject.call<void>("setVideoSize", videoWidth, videoHeight);
            int size = videoWidth * videoHeight;
            if (y)
                free((void *)y);
            y = (u32)malloc(size * 3 >> 1);
            u = y + size;
            v = u + (size >> 2);
        }
        u32 dst = y;
        for (int i = 0; i < videoHeight; i++)
        {
            memcpy((u8 *)dst, (const u8 *)(frame->data[0] + i * frame->linesize[0]), videoWidth);
            dst += videoWidth;
        }
        dst = u;
        int halfh = videoHeight >> 1;
        int halfw = videoWidth >> 1;
        for (int i = 0; i < halfh; i++)
        {
            memcpy((u8 *)dst, (const u8 *)(frame->data[1] + i * frame->linesize[1]), halfw);
            dst += halfw;
        }

        for (int i = 0; i < halfh; i++)
        {
            memcpy((u8 *)dst, (const u8 *)(frame->data[2] + i * frame->linesize[2]), halfw);
            dst += halfw;
        }
        jsObject.call<void>("draw", timestamp, y, u, v);
    }
};

#define FUNC(name) function(#name, &FFmpegAudioDecoder::name)
#undef PROP
#define PROP(name) property(#name, &FFmpegAudioDecoder::get##name, &FFmpegAudioDecoder::set##name)
EMSCRIPTEN_BINDINGS(FFmpegAudioDecoder)
{
    class_<FFmpegAudioDecoder>("AudioDecoder")
        .constructor<val>()
        .PROP(sample_rate)
        .FUNC(clear)
        .FUNC(decode);
}
#undef FUNC
#define FUNC(name) function(#name, &FFmpegVideoDecoder::name)
#undef PROP
#define PROP(name) property(#name, &FFmpegVideoDecoder::get##name, &FFmpegVideoDecoder::set##name)
EMSCRIPTEN_BINDINGS(FFmpegVideoDecoder)
{
    class_<FFmpegVideoDecoder>("VideoDecoder")
        .constructor<val>()
        .FUNC(clear)
        .FUNC(decode);
}
