#ifndef BB_BOX_H264_ENCODER_H
#define BB_BOX_H264_ENCODER_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
  int width, height;
  uint8_t *y, *u, *v;
} YuvPicture;

typedef struct {
  const char *name;
  int (*open)(int width, int height);
  int (*encode)(const YuvPicture *picture, int key, int64_t pts);
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

extern YuvPicture picture;
extern int have_picture;
int64_t monotonic_us(void);
void fit_picture(int width, int height);
void bgra_to_i420(const uint8_t *bgra, size_t stride);
void encode_picture(int key, int64_t started_us);
int read_all(void *into, size_t size);
uint32_t read_u32(void);
int follow_simulator(const char *udid, const char *developer, int scale_thousandths);

#endif
