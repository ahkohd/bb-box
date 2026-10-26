#ifndef BB_BOX_H264_ENCODER_H
#define BB_BOX_H264_ENCODER_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  int width, height;
  uint8_t *y, *u, *v;
} Picture;

typedef struct {
  const char *name;
  int (*open)(int width, int height);
  int (*encode)(const Picture *picture, int key, int64_t pts);
  void (*close)(void);
  void (*describe)(char *words, size_t size);
} Encoder;

typedef struct {
  int bitrate_kbps, fps, threads;
  const char *openh264_library;
} Settings;

extern Settings settings;
extern const Encoder X264_ENCODER;
extern const Encoder OPENH264_ENCODER;

void refuse(const char *format, ...) __attribute__((noreturn, format(printf, 1, 2)));
void append_to_unit(const uint8_t *bytes, size_t size);
void mark_unit_key(int key);

#endif
