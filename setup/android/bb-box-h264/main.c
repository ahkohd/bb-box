#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include "encoder.h"

#ifndef BB_H264_OPENH264_LIBRARY
#define BB_H264_OPENH264_LIBRARY "libopenh264.so.8"
#endif

enum { LARGEST_SIDE = 4096, HEADER_SIZE = 17, KEY_FLAG = 1, LONGEST_PATH = 4096 };

Settings settings = {8000, 60, 1, BB_H264_OPENH264_LIBRARY};

static uint8_t *unit;
static size_t unit_size, unit_capacity;
static int unit_key;

void refuse(const char *format, ...) {
  va_list words;
  va_start(words, format);
  fputs("bb-box-h264: ", stderr);
  vfprintf(stderr, format, words);
  fputc('\n', stderr);
  va_end(words);
  exit(2);
}

void mark_unit_key(int key) {
  unit_key = key;
}

static void begin_unit(void) {
  unit_size = 0;
  unit_key = 0;
  uint8_t header[HEADER_SIZE] = {0};
  append_to_unit(header, HEADER_SIZE);
}

void append_to_unit(const uint8_t *bytes, size_t size) {
  if (unit_size + size > unit_capacity) {
    unit_capacity = (unit_size + size) * 2;
    unit = realloc(unit, unit_capacity);
    if (!unit) refuse("out of memory for an access unit of %zu bytes", unit_size + size);
  }
  if (size) memcpy(unit + unit_size, bytes, size);
  unit_size += size;
}

static const Encoder *const ENCODERS[] = {
#ifdef BB_H264_WITH_X264
  &X264_ENCODER,
#endif
  &OPENH264_ENCODER,
};

static const Encoder *encoder;
static Picture picture;
static int encoder_open, have_picture;

static void rgb_to_i420(const uint8_t *rgb) {
  int width = picture.width, height = picture.height, stride = width * 3, half = width / 2;
  for (int j = 0; j < height; j += 2) {
    const uint8_t *top = rgb + (size_t)j * stride, *bottom = top + stride;
    uint8_t *y_top = picture.y + (size_t)j * width, *y_bottom = y_top + width;
    uint8_t *u = picture.u + (size_t)(j / 2) * half, *v = picture.v + (size_t)(j / 2) * half;
    for (int i = 0; i < width; i += 2) {
      const uint8_t *a = top + i * 3, *b = a + 3, *c = bottom + i * 3, *d = c + 3;
      y_top[i] = (uint8_t)(((66 * a[0] + 129 * a[1] + 25 * a[2] + 128) >> 8) + 16);
      y_top[i + 1] = (uint8_t)(((66 * b[0] + 129 * b[1] + 25 * b[2] + 128) >> 8) + 16);
      y_bottom[i] = (uint8_t)(((66 * c[0] + 129 * c[1] + 25 * c[2] + 128) >> 8) + 16);
      y_bottom[i + 1] = (uint8_t)(((66 * d[0] + 129 * d[1] + 25 * d[2] + 128) >> 8) + 16);
      int r = a[0] + b[0] + c[0] + d[0], g = a[1] + b[1] + c[1] + d[1], bl = a[2] + b[2] + c[2] + d[2];
      u[i / 2] = (uint8_t)((-38 * r - 74 * g + 112 * bl + (128 << 10) + 512) >> 10);
      v[i / 2] = (uint8_t)((112 * r - 94 * g - 18 * bl + (128 << 10) + 512) >> 10);
    }
  }
}

static int64_t monotonic_us(void) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (int64_t)now.tv_sec * 1000000 + now.tv_nsec / 1000;
}

static void check_size(uint32_t width, uint32_t height) {
  if (width == 0 || height == 0 || width > LARGEST_SIDE || height > LARGEST_SIDE)
    refuse("a frame of %ux%u is outside 2x2 to %dx%d", width, height, LARGEST_SIDE, LARGEST_SIDE);
  if (width % 2 || height % 2) refuse("a frame of %ux%u has an odd side, and H.264's 4:2:0 needs even ones", width, height);
}

static void fit_picture(int width, int height) {
  if (encoder_open && picture.width == width && picture.height == height) return;
  if (encoder_open) encoder->close();
  free(picture.y);
  picture.width = width;
  picture.height = height;
  size_t luma = (size_t)width * height;
  picture.y = malloc(luma + luma / 2);
  if (!picture.y) refuse("out of memory for a %dx%d picture", width, height);
  picture.u = picture.y + luma;
  picture.v = picture.u + luma / 4;
  if (encoder->open(width, height) != 0) refuse("%s could not open an encoder at %dx%d", encoder->name, width, height);
  encoder_open = 1;
  have_picture = 0;
}

static void write_all(const uint8_t *bytes, size_t size) {
  while (size) {
    ssize_t written = write(1, bytes, size);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) exit(0);
    bytes += written;
    size -= (size_t)written;
  }
}

static void put_u32(uint8_t *at, uint32_t value) {
  at[0] = (uint8_t)value;
  at[1] = (uint8_t)(value >> 8);
  at[2] = (uint8_t)(value >> 16);
  at[3] = (uint8_t)(value >> 24);
}

static void answer(int64_t started_us) {
  put_u32(unit, (uint32_t)(unit_size - HEADER_SIZE));
  unit[4] = unit_key ? KEY_FLAG : 0;
  put_u32(unit + 5, (uint32_t)picture.width);
  put_u32(unit + 9, (uint32_t)picture.height);
  put_u32(unit + 13, (uint32_t)(monotonic_us() - started_us));
  write_all(unit, unit_size);
}

static void answer_nothing(void) {
  begin_unit();
  answer(monotonic_us());
}

static int64_t last_pts = -1;

static void encode_picture(int key, int64_t started_us) {
  int64_t pts = started_us / 1000;
  if (pts <= last_pts) pts = last_pts + 1;
  last_pts = pts;
  begin_unit();
  if (encoder->encode(&picture, key, pts) != 0) refuse("%s failed to encode a %dx%d frame", encoder->name, picture.width, picture.height);
  answer(started_us);
}

static int read_all(void *into, size_t size) {
  uint8_t *at = into;
  while (size) {
    ssize_t got = read(0, at, size);
    if (got < 0 && errno == EINTR) continue;
    if (got <= 0) return -1;
    at += got;
    size -= (size_t)got;
  }
  return 0;
}

static uint32_t read_u32(void) {
  uint8_t bytes[4];
  if (read_all(bytes, 4) != 0) refuse("the input ended inside a command");
  return bytes[0] | (uint32_t)bytes[1] << 8 | (uint32_t)bytes[2] << 16 | (uint32_t)bytes[3] << 24;
}

static struct {
  int fd;
  const uint8_t *bytes;
  size_t size;
} shared = {-1, NULL, 0};

static void open_shared(void) {
  uint32_t length = read_u32();
  if (length == 0 || length >= LONGEST_PATH) refuse("a shared-memory path must have 1 to %d bytes, not %u", LONGEST_PATH - 1, length);
  char path[LONGEST_PATH];
  if (read_all(path, length) != 0) refuse("the input ended inside a shared-memory path");
  path[length] = 0;
  if (shared.bytes) munmap((void *)shared.bytes, shared.size);
  if (shared.fd >= 0) close(shared.fd);
  shared.bytes = NULL;
  shared.size = 0;
  shared.fd = open(path, O_RDONLY | O_CLOEXEC);
  if (shared.fd < 0) refuse("cannot open shared memory %s: %s", path, strerror(errno));
}

static const uint8_t *shared_frame(size_t size) {
  if (shared.fd < 0) refuse("a shared frame came before any shared memory was named");
  if (shared.bytes && shared.size >= size) return shared.bytes;
  struct stat file;
  if (fstat(shared.fd, &file) != 0 || (size_t)file.st_size < size)
    refuse("the shared memory holds %lld bytes, short of a frame's %zu", (long long)file.st_size, size);
  if (shared.bytes) munmap((void *)shared.bytes, shared.size);
  shared.size = (size_t)file.st_size;
  shared.bytes = mmap(NULL, shared.size, PROT_READ, MAP_SHARED, shared.fd, 0);
  if (shared.bytes == MAP_FAILED) refuse("cannot map the shared memory: %s", strerror(errno));
  return shared.bytes;
}

static void usage(void) {
  fputs("usage: bb-box-h264 [--encoder x264|openh264] [--openh264 library] [--bitrate kbit/s] [--fps n] [--threads n] [--version]\n",
        stderr);
  exit(2);
}

static int whole(const char *text, int least, int most) {
  char *end;
  long value = strtol(text, &end, 10);
  if (*text == 0 || *end != 0 || value < least || value > most) usage();
  return (int)value;
}

int main(int argc, char **argv) {
  int show_version = 0;
  encoder = ENCODERS[0];
  for (int a = 1; a < argc; a++) {
    const char *option = argv[a], *value = a + 1 < argc ? argv[a + 1] : NULL;
    if (!strcmp(option, "--version")) { show_version = 1; continue; }
    if (!value) usage();
    a++;
    if (!strcmp(option, "--encoder")) {
      size_t count = sizeof ENCODERS / sizeof ENCODERS[0], e = 0;
      while (e < count && strcmp(ENCODERS[e]->name, value)) e++;
      if (e == count) refuse("this helper was built without %s", value);
      encoder = ENCODERS[e];
    } else if (!strcmp(option, "--openh264")) settings.openh264_library = value;
    else if (!strcmp(option, "--bitrate")) settings.bitrate_kbps = whole(value, 100, 200000);
    else if (!strcmp(option, "--fps")) settings.fps = whole(value, 1, 240);
    else if (!strcmp(option, "--threads")) settings.threads = whole(value, 1, 16);
    else usage();
  }
  char words[128];
  encoder->describe(words, sizeof words);
  if (show_version) {
    puts(words);
    return 0;
  }
  fprintf(stderr, "bb-box-h264: %s, %d kbit/s, %d thread%s\n", words, settings.bitrate_kbps, settings.threads,
          settings.threads == 1 ? "" : "s");
  uint8_t *rgb = NULL;
  size_t rgb_capacity = 0;
  int key_pending = 0;
  for (;;) {
    uint8_t command;
    if (read_all(&command, 1) != 0) break;
    if (command == 'K') {
      if (have_picture) {
        encode_picture(1, monotonic_us());
      } else {
        key_pending = 1;
        answer_nothing();
      }
      continue;
    }
    if (command == 'M') {
      open_shared();
      continue;
    }
    if (command != 'F' && command != 'S') refuse("unknown command byte 0x%02x", command);
    uint32_t width = read_u32(), height = read_u32();
    check_size(width, height);
    size_t size = (size_t)width * height * 3;
    const uint8_t *frame;
    if (command == 'F') {
      if (size > rgb_capacity) {
        free(rgb);
        rgb = malloc(size);
        if (!rgb) refuse("out of memory for a %ux%u frame", width, height);
        rgb_capacity = size;
      }
      if (read_all(rgb, size) != 0) refuse("the input ended inside a %ux%u frame", width, height);
      frame = rgb;
    } else {
      frame = shared_frame(size);
    }
    int64_t started = monotonic_us();
    fit_picture((int)width, (int)height);
    rgb_to_i420(frame);
    have_picture = 1;
    encode_picture(key_pending, started);
    key_pending = 0;
  }
  if (encoder_open) encoder->close();
  free(rgb);
  free(picture.y);
  free(unit);
  return 0;
}
