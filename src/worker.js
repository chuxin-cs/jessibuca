import Module from './decoder/decoder';
import createWebGL from './utils/webgl';
import {WORKER_CMD_TYPE, MEDIA_TYPE, WORKER_SEND_TYPE, ENCODED_VIDEO_TYPE, DEFAULT_PLAYER_OPTIONS} from "./constant";
import {formatVideoDecoderConfigure, isGreenYUV} from "./utils";

function shouldDecodeAudioWhileDropping(payload) {
    if (!payload || payload.length === 0) {
        return false;
    }

    const audioType = payload[0] >> 4;

    if (audioType === 10) {
        return payload.length > 1 && payload[1] === 0;
    }

    return audioType === 2 || audioType === 7 || audioType === 8;
}

function isFlvMp3Audio(payload) {
    return payload && payload.length > 1 && (payload[0] >> 4) === 2;
}

function parseMp3FrameHeader(data, offset) {
    if (!data || offset + 4 > data.length) {
        return null;
    }

    const header = (data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3];
    if (((header >>> 21) & 0x7ff) !== 0x7ff) {
        return null;
    }

    const version = (header >> 19) & 0x03;
    const layer = (header >> 17) & 0x03;
    const bitrateIndex = (header >> 12) & 0x0f;
    const sampleRateIndex = (header >> 10) & 0x03;
    const padding = (header >> 9) & 0x01;
    const channelMode = (header >> 6) & 0x03;

    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) {
        return null;
    }

    const sampleRates = {
        3: [44100, 48000, 32000],
        2: [22050, 24000, 16000],
        0: [11025, 12000, 8000]
    };
    const bitrateMpeg1Layer3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
    const bitrateMpeg2Layer3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    const sampleRate = sampleRates[version] && sampleRates[version][sampleRateIndex];
    const bitrate = version === 3 ? bitrateMpeg1Layer3[bitrateIndex] : bitrateMpeg2Layer3[bitrateIndex];
    if (!sampleRate || !bitrate) {
        return null;
    }

    return {
        sampleRate,
        channels: channelMode === 3 ? 1 : 2,
        frameLength: Math.floor((version === 3 ? 144 : 72) * bitrate * 1000 / sampleRate) + padding,
        frameDuration: Math.round((version === 3 ? 1152 : 576) * 1000 / sampleRate)
    };
}

if (!Date.now) Date.now = function () {
    return new Date().getTime();
};

Module.postRun = function () {
    var buffer = [];
    var wcsVideoDecoder = {};
    var createAudioChunkState = function (paced) {
        return {
            remain: 0,
            tempAudioBuffer: [],
            tempTimestamp: 0,
            paced: !!paced,
            pacedQueue: [],
            pacedTimer: null,
            pacedSampleRate: 0,
            pacedPrimeCount: 0
        };
    };
    var postAudioChunk = function (outputArray, ts) {
        postMessage({
            cmd: WORKER_CMD_TYPE.playAudio,
            buffer: outputArray,
            ts
        }, outputArray.map(x => x.buffer));
    };
    var getAudioChunkDuration = function (sampleRate) {
        return sampleRate ? Math.max(Math.round(1024 * 1000 / sampleRate), 1) : 20;
    };
    var clearPacedAudioChunks = function (state) {
        if (state.pacedTimer) {
            clearTimeout(state.pacedTimer);
            state.pacedTimer = null;
        }
        state.pacedQueue = [];
        state.pacedSampleRate = 0;
        state.pacedPrimeCount = 0;
    };
    var drainPacedAudioChunks = function (state) {
        if (!state.pacedQueue.length) {
            state.pacedTimer = null;
            return;
        }

        var item = state.pacedQueue.shift();
        postAudioChunk(item.buffer, item.ts);
        state.pacedTimer = setTimeout(function () {
            drainPacedAudioChunks(state);
        }, getAudioChunkDuration(state.pacedSampleRate));
    };
    var emitAudioChunk = function (outputArray, ts, state, sampleRate) {
        if (!state || !state.paced) {
            postAudioChunk(outputArray, ts);
            return;
        }

        state.pacedSampleRate = sampleRate || state.pacedSampleRate;
        if (state.pacedPrimeCount < 24) {
            state.pacedPrimeCount++;
            postAudioChunk(outputArray, ts);
            return;
        }

        state.pacedQueue.push({
            buffer: outputArray,
            ts
        });
        while (state.pacedQueue.length > 80) {
            state.pacedQueue.shift();
        }

        if (!state.pacedTimer) {
            state.pacedTimer = setTimeout(function () {
                drainPacedAudioChunks(state);
            }, getAudioChunkDuration(state.pacedSampleRate));
        }
    };
    var getAudioChunkTimestamp = function (ts, offset, sampleRate) {
        if (!sampleRate) {
            return ts;
        }

        return Math.max(Math.round((ts || 0) + offset * 1000 / sampleRate), 0);
    };
    var pushPlanarAudioChunks = function (origin, frameCount, channels, ts, state, sampleRate) {
        var start = 0;

        if (state.remain) {
            var need = 1024 - state.remain;
            if (frameCount >= need) {
                var outputArray = [];
                for (var channel = 0; channel < channels; channel++) {
                    outputArray[channel] = new Float32Array(1024);
                    if (state.tempAudioBuffer[channel]) {
                        outputArray[channel].set(state.tempAudioBuffer[channel], 0);
                    }
                    outputArray[channel].set(origin[channel].subarray(0, need), state.remain);
                }
                emitAudioChunk(outputArray, state.tempTimestamp || ts, state, sampleRate);
                start = need;
                frameCount -= need;
                state.remain = 0;
                state.tempAudioBuffer = [];
                state.tempTimestamp = 0;
            } else {
                for (var remainChannel = 0; remainChannel < channels; remainChannel++) {
                    var combined = new Float32Array(state.remain + frameCount);
                    if (state.tempAudioBuffer[remainChannel]) {
                        combined.set(state.tempAudioBuffer[remainChannel], 0);
                    }
                    combined.set(origin[remainChannel], state.remain);
                    state.tempAudioBuffer[remainChannel] = combined;
                }
                state.remain += frameCount;
                return;
            }
        }

        while (frameCount >= 1024) {
            var chunk = [];
            for (var chunkChannel = 0; chunkChannel < channels; chunkChannel++) {
                chunk[chunkChannel] = origin[chunkChannel].slice(start, start + 1024);
            }
            emitAudioChunk(chunk, getAudioChunkTimestamp(ts, start, sampleRate), state, sampleRate);
            start += 1024;
            frameCount -= 1024;
        }

        if (frameCount) {
            for (var tailChannel = 0; tailChannel < channels; tailChannel++) {
                state.tempAudioBuffer[tailChannel] = origin[tailChannel].slice(start, start + frameCount);
            }
            state.remain = frameCount;
            state.tempTimestamp = getAudioChunkTimestamp(ts, start, sampleRate);
        } else {
            state.remain = 0;
            state.tempAudioBuffer = [];
            state.tempTimestamp = 0;
        }
    };
    var resamplePlanarAudio = function (origin, frameCount, channels, sourceSampleRate, targetSampleRate) {
        if (!sourceSampleRate || !targetSampleRate || sourceSampleRate === targetSampleRate) {
            return {
                output: origin,
                frameCount
            };
        }

        if (targetSampleRate % sourceSampleRate === 0) {
            var ratio = targetSampleRate / sourceSampleRate;
            if (ratio > 1 && ratio <= 12) {
                var integerFrameCount = frameCount * ratio;
                var integerOutput = [];
                for (var integerChannel = 0; integerChannel < channels; integerChannel++) {
                    var integerInput = origin[integerChannel];
                    var integerResampled = new Float32Array(integerFrameCount);
                    var writeIndex = 0;
                    for (var inputIndex = 0; inputIndex < frameCount; inputIndex++) {
                        var leftSample = integerInput[inputIndex];
                        var rightSample = inputIndex + 1 < frameCount ? integerInput[inputIndex + 1] : leftSample;
                        var step = (rightSample - leftSample) / ratio;
                        for (var ratioIndex = 0; ratioIndex < ratio; ratioIndex++) {
                            integerResampled[writeIndex++] = leftSample + step * ratioIndex;
                        }
                    }
                    integerOutput[integerChannel] = integerResampled;
                }

                return {
                    output: integerOutput,
                    frameCount: integerFrameCount
                };
            }
        }

        var targetFrameCount = Math.max(1, Math.round(frameCount * targetSampleRate / sourceSampleRate));
        var output = [];
        for (var channel = 0; channel < channels; channel++) {
            var input = origin[channel];
            var resampled = new Float32Array(targetFrameCount);
            for (var i = 0; i < targetFrameCount; i++) {
                var sourceIndex = i * sourceSampleRate / targetSampleRate;
                var left = Math.floor(sourceIndex);
                var right = Math.min(left + 1, frameCount - 1);
                var weight = sourceIndex - left;
                resampled[i] = input[left] * (1 - weight) + input[right] * weight;
            }
            output[channel] = resampled;
        }

        return {
            output,
            frameCount: targetFrameCount
        };
    };
    var webcodecsAudioDecoder = {
        decoder: null,
        hasInit: false,
        hasError: false,
        channels: 0,
        sampleRate: 0,
        targetSampleRate: 0,
        audioChunkState: createAudioChunkState(true),
        pendingBuffer: null,
        pendingTimestamp: 0,
        nextFrameTimestamp: null,
        canDecode: function (payload) {
            return isFlvMp3Audio(payload) &&
                typeof AudioDecoder !== 'undefined' &&
                typeof EncodedAudioChunk !== 'undefined' &&
                typeof AudioData !== 'undefined';
        },
        setTargetSampleRate: function (sampleRate) {
            this.targetSampleRate = sampleRate || 0;
        },
        ensureDecoder: function (frameInfo) {
            if (this.decoder || this.hasError) {
                return !!this.decoder;
            }

            var config = {
                codec: 'mp3',
                sampleRate: frameInfo.sampleRate,
                numberOfChannels: frameInfo.channels
            };
            this.channels = frameInfo.channels;
            this.sampleRate = frameInfo.sampleRate;
            try {
                this.decoder = new AudioDecoder({
                    output: (audioData) => {
                        this.handleDecode(audioData);
                    },
                    error: (error) => {
                        this.hasError = true;
                        console.warn('Jb: [worker]: WebCodecs AudioDecoder error', error);
                    }
                });
                this.decoder.configure(config);
                postMessage({cmd: WORKER_CMD_TYPE.audioCode, code: 2});
                return true;
            } catch (error) {
                this.hasError = true;
                this.decoder = null;
                console.warn('Jb: [worker]: WebCodecs AudioDecoder configure error', error);
                return false;
            }
        },
        decode: function (payload, ts) {
            var input = payload.slice(1);
            if (this.pendingBuffer && this.pendingBuffer.length) {
                var combined = new Uint8Array(this.pendingBuffer.length + input.length);
                combined.set(this.pendingBuffer);
                combined.set(input, this.pendingBuffer.length);
                input = combined;
            } else {
                var tagTimestamp = Math.max(ts || 0, 0);
                if (this.nextFrameTimestamp === null || Math.abs(tagTimestamp - this.nextFrameTimestamp) > 1000) {
                    this.nextFrameTimestamp = tagTimestamp;
                }
                this.pendingTimestamp = this.nextFrameTimestamp;
            }

            var offset = 0;
            var frameTimestamp = this.pendingTimestamp;
            while (offset < input.length) {
                var frameInfo = parseMp3FrameHeader(input, offset);
                if (!frameInfo) {
                    offset++;
                    frameTimestamp = Math.max(ts || frameTimestamp || 0, 0);
                    continue;
                }

                if (offset + frameInfo.frameLength > input.length) {
                    break;
                }

                if (!this.ensureDecoder(frameInfo)) {
                    return false;
                }

                try {
                    this.decoder.decode(new EncodedAudioChunk({
                        type: 'key',
                        timestamp: Math.max(frameTimestamp || 0, 0) * 1000,
                        data: input.slice(offset, offset + frameInfo.frameLength)
                    }));
                } catch (error) {
                    this.hasError = true;
                    console.warn('Jb: [worker]: WebCodecs AudioDecoder decode error', error);
                    return false;
                }

                offset += frameInfo.frameLength;
                frameTimestamp += frameInfo.frameDuration;
            }

            this.pendingBuffer = offset < input.length ? input.slice(offset) : null;
            this.pendingTimestamp = this.pendingBuffer ? frameTimestamp : 0;
            this.nextFrameTimestamp = frameTimestamp;
            return true;
        },
        handleDecode: function (audioData) {
            var channels = audioData.numberOfChannels || this.channels || 2;
            var sampleRate = audioData.sampleRate || this.sampleRate || 44100;
            var targetSampleRate = this.targetSampleRate || sampleRate;
            var frameCount = audioData.numberOfFrames;
            var output = [];

            if (!this.hasInit) {
                postMessage({cmd: WORKER_CMD_TYPE.initAudio, sampleRate: targetSampleRate, channels: channels});
                this.hasInit = true;
            }

            try {
                for (var channel = 0; channel < channels; channel++) {
                    output[channel] = new Float32Array(frameCount);
                    audioData.copyTo(output[channel], {
                        planeIndex: channel,
                        format: 'f32-planar'
                    });
                }
                var audio = resamplePlanarAudio(output, frameCount, channels, sampleRate, targetSampleRate);
                pushPlanarAudioChunks(audio.output, audio.frameCount, channels, Math.max(Math.round(audioData.timestamp / 1000), 0), this.audioChunkState, targetSampleRate);
            } finally {
                audioData.close();
            }
        },
        reset: function () {
            if (this.decoder) {
                if (this.decoder.state !== 'closed') {
                    this.decoder.close();
                }
                this.decoder = null;
            }
            this.hasInit = false;
            this.hasError = false;
            this.channels = 0;
            this.sampleRate = 0;
            this.targetSampleRate = 0;
            clearPacedAudioChunks(this.audioChunkState);
            this.audioChunkState = createAudioChunkState(true);
            this.pendingBuffer = null;
            this.pendingTimestamp = 0;
            this.nextFrameTimestamp = null;
        }
    };
    if ("VideoEncoder" in self) {
        wcsVideoDecoder = {
            hasInit: false,
            isEmitInfo: false,
            offscreenCanvas: null,
            offscreenCanvasCtx: null,
            decoder: new VideoDecoder({
                output: function (videoFrame) {
                    if (decoder.isDestroyed) {
                        return;
                    }

                    if (!wcsVideoDecoder.isEmitInfo) {
                        decoder.opt.debug && console.log('Jb: [worker] Webcodecs Video Decoder initSize');
                        postMessage({
                            cmd: WORKER_CMD_TYPE.initVideo,
                            w: videoFrame.codedWidth,
                            h: videoFrame.codedHeight
                        });
                        wcsVideoDecoder.isEmitInfo = true;
                        wcsVideoDecoder.offscreenCanvas = new OffscreenCanvas(videoFrame.codedWidth, videoFrame.codedHeight);
                        wcsVideoDecoder.offscreenCanvasCtx = wcsVideoDecoder.offscreenCanvas.getContext("2d");
                    }

                    wcsVideoDecoder.offscreenCanvasCtx.drawImage(videoFrame, 0, 0, videoFrame.codedWidth, videoFrame.codedHeight);
                    let image_bitmap = wcsVideoDecoder.offscreenCanvas.transferToImageBitmap();
                    postMessage({
                        cmd: WORKER_CMD_TYPE.render,
                        buffer: image_bitmap,
                        delay: decoder.delay,
                        ts: 0
                    }, [image_bitmap]);

                    setTimeout(function () {
                        if (videoFrame.close) {
                            videoFrame.close();
                        } else {
                            videoFrame.destroy();
                        }
                    }, 100);

                },
                error: function (error) {
                    console.error(error);
                }
            }),
            decode: function (payload, ts) {
                const isIFrame = payload[0] >> 4 === 1;
                if (!wcsVideoDecoder.hasInit) {
                    if (isIFrame && payload[1] === 0) {
                        const videoCodec = (payload[0] & 0x0F);
                        decoder.setVideoCodec(videoCodec);
                        const config = formatVideoDecoderConfigure(payload.slice(5));
                        try {
                            wcsVideoDecoder.decoder.configure(config);
                        } catch (error) {
                            if (!config.hardwareAcceleration) {
                                throw error;
                            }

                            const fallbackConfig = Object.assign({}, config);
                            delete fallbackConfig.hardwareAcceleration;
                            wcsVideoDecoder.decoder.configure(fallbackConfig);
                        }
                        wcsVideoDecoder.hasInit = true;
                    }
                } else {
                    const chunk = new EncodedVideoChunk({
                        data: payload.slice(5),
                        timestamp: ts,
                        type: isIFrame ? ENCODED_VIDEO_TYPE.key : ENCODED_VIDEO_TYPE.delta
                    });
                    wcsVideoDecoder.decoder.decode(chunk);
                }
            },
            reset() {
                wcsVideoDecoder.hasInit = false;
                wcsVideoDecoder.isEmitInfo = false;
                wcsVideoDecoder.offscreenCanvas = null;
                wcsVideoDecoder.offscreenCanvasCtx = null;
            }
        };
    }

    var decoder = {
        isDestroyed: false,
        opt: {
            debug: DEFAULT_PLAYER_OPTIONS.debug,
            useOffscreen: DEFAULT_PLAYER_OPTIONS.useOffscreen,
            useWCS: DEFAULT_PLAYER_OPTIONS.useWCS,
            videoBuffer: DEFAULT_PLAYER_OPTIONS.videoBuffer,
            openWebglAlignment: DEFAULT_PLAYER_OPTIONS.openWebglAlignment,
            videoBufferDelay: DEFAULT_PLAYER_OPTIONS.videoBufferDelay
        },
        useOffscreen: function () {
            return decoder.opt.useOffscreen && typeof OffscreenCanvas != 'undefined';
        },
        initAudioPlanar: function (channels, samplerate) {
            postMessage({cmd: WORKER_CMD_TYPE.initAudio, sampleRate: samplerate, channels: channels});
            var audioChunkState = createAudioChunkState();
            this.playAudioPlanar = function (data, len, ts) {
                var frameCount = len;
                var origin = [];
                for (var channel = 0; channel < channels; channel++) {
                    var fp = Module.HEAPU32[(data >> 2) + channel] >> 2;
                    origin[channel] = Module.HEAPF32.subarray(fp, fp + frameCount);
                }
                pushPlanarAudioChunks(origin, frameCount, channels, ts, audioChunkState);
            };
        },
        setVideoCodec: function (code) {
            postMessage({cmd: WORKER_CMD_TYPE.videoCode, code});
        },
        setAudioCodec: function (code) {
            postMessage({cmd: WORKER_CMD_TYPE.audioCode, code});
        },
        setVideoSize: function (w, h) {
            postMessage({cmd: WORKER_CMD_TYPE.initVideo, w: w, h: h});
            var size = w * h;
            var qsize = size >> 2;
            if (decoder.useOffscreen()) {
                this.offscreenCanvas = new OffscreenCanvas(w, h);
                this.offscreenCanvasGL = this.offscreenCanvas.getContext("webgl");
                this.webglObj = createWebGL(this.offscreenCanvasGL, decoder.opt.openWebglAlignment);
                this.draw = function (ts, y, u, v) {
                    const yData = Module.HEAPU8.subarray(y, y + size);
                    const uData = Module.HEAPU8.subarray(u, u + qsize);
                    const vData = Module.HEAPU8.subarray(v, v + (qsize));
                    // if (isGreenYUV(Uint8Array.from(yData))) {
                    //     decoder.opt.debug && console.log('Jb: [worker]: draw offscreenCanvas is green yuv');
                    //     return
                    // }

                    this.webglObj.render(w, h, yData, uData, vData);
                    let image_bitmap = this.offscreenCanvas.transferToImageBitmap();
                    postMessage({
                        cmd: WORKER_CMD_TYPE.render,
                        buffer: image_bitmap,
                        delay: this.delay,
                        ts
                    }, [image_bitmap]);
                };
            } else {
                this.draw = function (ts, y, u, v) {
                    const yData = Uint8Array.from(Module.HEAPU8.subarray(y, y + size));
                    const uData = Uint8Array.from(Module.HEAPU8.subarray(u, u + qsize));
                    const vData = Uint8Array.from(Module.HEAPU8.subarray(v, v + (qsize)));
                    // if (isGreenYUV(yData)) {
                    //     decoder.opt.debug && console.log('Jb: [worker]: draw is green yuv');
                    //     return
                    // }
                    const outputArray = [yData, uData, vData];
                    postMessage({
                        cmd: WORKER_CMD_TYPE.render,
                        output: outputArray,
                        delay: this.delay,
                        ts
                    }, outputArray.map(x => x.buffer));
                };
            }
        },
        getDelay: function (timestamp) {
            if (!timestamp) {
                return -1;
            }
            if (!this.firstTimestamp) {
                this.firstTimestamp = timestamp;
                this.startTimestamp = Date.now();
                this.delay = -1;
            } else {

                if (timestamp) {
                    const localTimestamp = (Date.now() - this.startTimestamp);
                    const timeTimestamp = (timestamp - this.firstTimestamp);
                    if (localTimestamp >= timeTimestamp) {
                        this.delay = localTimestamp - timeTimestamp;
                    } else {
                        this.delay = timeTimestamp - localTimestamp;
                    }
                }
            }
            return this.delay;
        },
        resetDelay: function () {
            this.firstTimestamp = null;
            this.startTimestamp = null;
            this.delay = -1;
        },

        init: function () {
            decoder.opt.debug && console.log('Jb: [worker] init');
            const _doDecode = (data) => {
                // decoder.opt.debug && console.log('Jb: [worker]: _doDecode');
                if (data.type === MEDIA_TYPE.audio && webcodecsAudioDecoder.canDecode(data.payload)) {
                    webcodecsAudioDecoder.decode(data.payload, data.ts);
                } else if (decoder.opt.useWCS && decoder.useOffscreen() && data.type === MEDIA_TYPE.video && wcsVideoDecoder.decode) {
                    wcsVideoDecoder.decode(data.payload, data.ts);
                } else {
                    // decoder.opt.debug && console.log('Jb: [worker]: _doDecode  wasm');
                    data.decoder.decode(data.payload, data.ts);
                }
            };
            const loop = () => {
                if (decoder.isDestroyed) {
                    return;
                }

                if (buffer.length) {
                    if (this.dropping) {
                        // // dropping
                        data = buffer.shift();
                        //
                        if (data.type === MEDIA_TYPE.audio && shouldDecodeAudioWhileDropping(data.payload)) {
                            _doDecode(data);
                        }
                        while (!data.isIFrame && buffer.length) {
                            // dropping
                            data = buffer.shift();
                            //
                            if (data.type === MEDIA_TYPE.audio && shouldDecodeAudioWhileDropping(data.payload)) {
                                _doDecode(data);
                            }
                        }
                        if (data.isIFrame) {
                            this.dropping = false;
                            _doDecode(data);
                        }
                    } else {
                        var data = buffer[0];
                        if (this.getDelay(data.ts) === -1) {
                            // decoder.opt.debug && console.log('Jb: [worker]: common dumex delay is -1');
                            buffer.shift();
                            _doDecode(data);
                        } else if (this.delay > decoder.opt.videoBuffer + decoder.opt.videoBufferDelay) {
                            // decoder.opt.debug && console.log('Jb: [worker]:', `delay is ${this.delay}, set dropping is true`);
                            this.resetDelay();
                            this.dropping = true;
                        } else {
                            while (buffer.length) {
                                data = buffer[0];
                                if (this.getDelay(data.ts) > decoder.opt.videoBuffer) {
                                    // decoder.opt.debug && console.log('Jb: [worker]:', `delay is ${this.delay}, decode`);
                                    buffer.shift();
                                    _doDecode(data);
                                } else {
                                    // decoder.opt.debug && console.log('Jb: [worker]:', `delay is ${this.delay},opt.videoBuffer is ${decoder.opt.videoBuffer}`);
                                    break;
                                }
                            }
                        }
                    }
                } else {
                }
            };
            this.stopId = setInterval(loop, 10);
        },
        close: function () {
            decoder.isDestroyed = true;
            decoder.opt.debug && console.log('Jb: [worker]: close');
            clearInterval(this.stopId);
            this.stopId = null;
            audioDecoder.clear && audioDecoder.clear();
            audioDecoder.delete && audioDecoder.delete();
            webcodecsAudioDecoder.reset();
            videoDecoder.clear && videoDecoder.clear();
            videoDecoder.delete && videoDecoder.delete();
            wcsVideoDecoder.reset && wcsVideoDecoder.reset();
            this.firstTimestamp = null;
            this.startTimestamp = null;
            this.delay = -1;
            this.dropping = false;

            if (this.webglObj) {
                this.webglObj.destroy();
                this.offscreenCanvas = null;
                this.offscreenCanvasGL = null;
                this.offscreenCanvasCtx = null;
            }
            buffer = [];
            delete this.playAudioPlanar;
            delete this.draw;
        },
        pushBuffer: function (bufferData, options) {
            // 音频
            if (options.type === MEDIA_TYPE.audio) {
                buffer.push({
                    ts: options.ts,
                    payload: bufferData,
                    decoder: audioDecoder,
                    type: MEDIA_TYPE.audio,
                });
            } else if (options.type === MEDIA_TYPE.video) {
                buffer.push({
                    ts: options.ts,
                    payload: bufferData,
                    decoder: videoDecoder,
                    type: MEDIA_TYPE.video,
                    isIFrame: options.isIFrame
                });
            }
        }
    };
    var audioDecoder = new Module.AudioDecoder(decoder);
    var videoDecoder = new Module.VideoDecoder(decoder);
    postMessage({cmd: WORKER_SEND_TYPE.init});
    self.onmessage = function (event) {
        var msg = event.data;
        switch (msg.cmd) {
            case WORKER_SEND_TYPE.init:
                try {
                    decoder.opt = Object.assign(decoder.opt, JSON.parse(msg.opt));
                } catch (e) {

                }
                audioDecoder.sample_rate = msg.sampleRate;
                webcodecsAudioDecoder.setTargetSampleRate(msg.sampleRate);
                decoder.init();
                break;
            case WORKER_SEND_TYPE.decode:
                decoder.pushBuffer(msg.buffer, msg.options);
                break;
            case WORKER_SEND_TYPE.audioDecode:
                if (!webcodecsAudioDecoder.canDecode(msg.buffer) || !webcodecsAudioDecoder.decode(msg.buffer, msg.ts)) {
                    audioDecoder.decode(msg.buffer, msg.ts);
                }
                break;
            case WORKER_SEND_TYPE.videoDecode:
                videoDecoder.decode(msg.buffer, msg.ts);
                break;
            case WORKER_SEND_TYPE.close:
                decoder.close();
                break;
            case WORKER_SEND_TYPE.updateConfig:
                decoder.opt[msg.key] = msg.value;
                break;
        }
    };
};
