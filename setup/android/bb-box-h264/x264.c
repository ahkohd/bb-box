#include <stdint.h>
#include <stdio.h>
#include <x264.h>

#include "encoder.h"

#ifndef BB_H264_X264_REVISION
#define BB_H264_X264_REVISION "unknown"
#endif

static x264_t *x264;
static int64_t frames_encoded;

static int x264_open(int width, int height) {
  x264_param_t param;
  if (x264_param_default_preset(&param, "ultrafast", "zerolatency") < 0) return -1;
  param.i_width = width;
  param.i_height = height;
  param.i_csp = X264_CSP_I420;
  param.i_threads = settings.threads;
  param.b_sliced_threads = settings.threads > 1;
  param.i_fps_num = (uint32_t)settings.fps;
  param.i_fps_den = 1;
  param.i_timebase_num = 1;
  param.i_timebase_den = (uint32_t)settings.fps;
  param.b_vfr_input = 0;
  param.i_keyint_max = X264_KEYINT_MAX_INFINITE;
  param.rc.i_rc_method = X264_RC_ABR;
  param.rc.i_bitrate = settings.bitrate_kbps;
  param.rc.i_vbv_max_bitrate = settings.bitrate_kbps;
  param.rc.i_vbv_buffer_size = settings.bitrate_kbps / 2;
  param.b_repeat_headers = 1;
  param.b_annexb = 1;
  param.i_log_level = X264_LOG_ERROR;
  if (x264_param_apply_profile(&param, "baseline") < 0) return -1;
  x264 = x264_encoder_open(&param);
  frames_encoded = 0;
  return x264 ? 0 : -1;
}

static int x264_encode(const YuvPicture *picture, int key, int64_t pts) {
  (void)pts;
  x264_picture_t in, out;
  x264_picture_init(&in);
  in.img.i_csp = X264_CSP_I420;
  in.img.i_plane = 3;
  in.img.plane[0] = picture->y;
  in.img.plane[1] = picture->u;
  in.img.plane[2] = picture->v;
  in.img.i_stride[0] = picture->width;
  in.img.i_stride[1] = in.img.i_stride[2] = picture->width / 2;
  in.i_type = key ? X264_TYPE_IDR : X264_TYPE_AUTO;
  in.i_pts = frames_encoded++;
  x264_nal_t *nals;
  int count;
  int size = x264_encoder_encode(x264, &nals, &count, &in, &out);
  if (size < 0) return -1;
  if (size > 0) append_to_unit(nals[0].p_payload, (size_t)size);
  mark_unit_key(out.b_keyframe);
  return 0;
}

static void x264_close(void) {
  if (x264) x264_encoder_close(x264);
  x264 = NULL;
}

static void x264_describe(char *words, size_t size) {
  snprintf(words, size, "x264 0.%d, source %s", X264_BUILD, BB_H264_X264_REVISION);
}

const Encoder X264_ENCODER = {"x264", x264_open, x264_encode, x264_close, x264_describe};
