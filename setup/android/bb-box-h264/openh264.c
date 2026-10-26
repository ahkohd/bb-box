#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <wels/codec_api.h>
#include <wels/codec_ver.h>

#include "encoder.h"

typedef int (*CreateOpenH264)(ISVCEncoder **);
typedef void (*DestroyOpenH264)(ISVCEncoder *);
typedef void (*OpenH264VersionOf)(OpenH264Version *);

static struct {
  void *library;
  CreateOpenH264 create;
  DestroyOpenH264 destroy;
  OpenH264VersionOf version;
  ISVCEncoder *encoder;
} openh264;

static void load_openh264(void) {
  if (openh264.library) return;
  openh264.library = dlopen(settings.openh264_library, RTLD_NOW | RTLD_LOCAL);
  if (!openh264.library) refuse("cannot load OpenH264 from %s: %s", settings.openh264_library, dlerror());
  openh264.create = (CreateOpenH264)dlsym(openh264.library, "WelsCreateSVCEncoder");
  openh264.destroy = (DestroyOpenH264)dlsym(openh264.library, "WelsDestroySVCEncoder");
  openh264.version = (OpenH264VersionOf)dlsym(openh264.library, "WelsGetCodecVersionEx");
  if (!openh264.create || !openh264.destroy || !openh264.version) refuse("%s is not an OpenH264 library", settings.openh264_library);
  OpenH264Version found;
  openh264.version(&found);
  if (found.uMajor != OPENH264_MAJOR || found.uMinor != OPENH264_MINOR)
    refuse("%s is OpenH264 %u.%u, and this helper was built for %d.%d", settings.openh264_library, found.uMajor, found.uMinor,
           OPENH264_MAJOR, OPENH264_MINOR);
}

static int openh264_open(int width, int height) {
  load_openh264();
  if (openh264.create(&openh264.encoder) != 0 || !openh264.encoder) return -1;
  ISVCEncoder *encoder = openh264.encoder;
  int quiet = WELS_LOG_QUIET;
  (*encoder)->SetOption(encoder, ENCODER_OPTION_TRACE_LEVEL, &quiet);
  SEncParamExt param;
  (*encoder)->GetDefaultParams(encoder, &param);
  int bitrate = settings.bitrate_kbps * 1000;
  param.iUsageType = SCREEN_CONTENT_REAL_TIME;
  param.iPicWidth = width;
  param.iPicHeight = height;
  param.iTargetBitrate = bitrate;
  param.iMaxBitrate = bitrate;
  param.iRCMode = RC_BITRATE_MODE;
  param.fMaxFrameRate = (float)settings.fps;
  param.iSpatialLayerNum = 1;
  param.iTemporalLayerNum = 1;
  param.uiIntraPeriod = 0;
  param.bEnableFrameSkip = false;
  param.iMultipleThreadIdc = (unsigned short)settings.threads;
  param.eSpsPpsIdStrategy = CONSTANT_ID;
  param.iEntropyCodingModeFlag = 0;
  SSpatialLayerConfig *layer = &param.sSpatialLayers[0];
  layer->iVideoWidth = width;
  layer->iVideoHeight = height;
  layer->fFrameRate = (float)settings.fps;
  layer->iSpatialBitrate = bitrate;
  layer->iMaxSpatialBitrate = bitrate;
  layer->uiProfileIdc = PRO_BASELINE;
  layer->sSliceArgument.uiSliceMode = settings.threads > 1 ? SM_FIXEDSLCNUM_SLICE : SM_SINGLE_SLICE;
  layer->sSliceArgument.uiSliceNum = (unsigned int)settings.threads;
  if ((*encoder)->InitializeExt(encoder, &param) != cmResultSuccess) return -1;
  int format = videoFormatI420;
  (*encoder)->SetOption(encoder, ENCODER_OPTION_DATAFORMAT, &format);
  return 0;
}

static int openh264_encode(const Picture *picture, int key, int64_t pts) {
  ISVCEncoder *encoder = openh264.encoder;
  SSourcePicture source;
  memset(&source, 0, sizeof source);
  source.iColorFormat = videoFormatI420;
  source.iPicWidth = picture->width;
  source.iPicHeight = picture->height;
  source.iStride[0] = picture->width;
  source.iStride[1] = source.iStride[2] = picture->width / 2;
  source.pData[0] = picture->y;
  source.pData[1] = picture->u;
  source.pData[2] = picture->v;
  source.uiTimeStamp = pts;
  if (key) (*encoder)->ForceIntraFrame(encoder, true);
  SFrameBSInfo info;
  memset(&info, 0, sizeof info);
  if ((*encoder)->EncodeFrame(encoder, &source, &info) != cmResultSuccess) return -1;
  if (info.eFrameType == videoFrameTypeSkip) return 0;
  for (int l = 0; l < info.iLayerNum; l++) {
    const SLayerBSInfo *layer = &info.sLayerInfo[l];
    size_t size = 0;
    for (int n = 0; n < layer->iNalCount; n++) size += (size_t)layer->pNalLengthInByte[n];
    append_to_unit(layer->pBsBuf, size);
  }
  mark_unit_key(info.eFrameType == videoFrameTypeIDR);
  return 0;
}

static void openh264_close(void) {
  if (!openh264.encoder) return;
  (*openh264.encoder)->Uninitialize(openh264.encoder);
  openh264.destroy(openh264.encoder);
  openh264.encoder = NULL;
}

static void openh264_describe(char *words, size_t size) {
  load_openh264();
  OpenH264Version found;
  openh264.version(&found);
  snprintf(words, size, "openh264 %u.%u.%u", found.uMajor, found.uMinor, found.uRevision);
}

const Encoder OPENH264_ENCODER = {"openh264", openh264_open, openh264_encode, openh264_close, openh264_describe};
