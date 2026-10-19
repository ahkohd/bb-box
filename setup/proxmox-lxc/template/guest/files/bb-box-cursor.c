// bb-box-cursor: the box's pointer on a Wayland desktop whose compositor has
// ext-image-copy-capture, as Sway 1.11 does (060): where it is and what it
// looks like, from a pointer cursor session on the desktop's output. Neither
// stream sends it: Selkies sends the browser one arrow and paints none, and
// wayvnc sends no position. bb-box shows the shape to the person in control
// and draws the agent's pointer over the picture for people watching.
//
// usage: cursor   (WAYLAND_DISPLAY in the environment)
// Writes a JSON line for each change, flushed:
//   {"enter":true} {"leave":true}           the pointer came onto, or left, the output
//   {"position":[x,y]}                      the pointer's hotspot, in the output's pixels
//   {"image":{"width":w,"height":h,"hotspot":[x,y],"argb":"<base64>"}}
//                                           a new cursor image: w*h pixels, 32-bit ARGB, little-endian
// The session opens once the seat has a pointer, which Sway's seat has only
// while a viewer or Cua Driver holds a virtual pointer, and closes, with a
// leave, while it has none. Exits 1 when the compositor lacks the protocols
// or the display goes, and 2 when the compositor ends the session, as when
// the output goes.
// Built by the Wayland desktop template (customize-desktop-wayland.sh) from
// the system's protocol XML, where it has ext-image-copy-capture.
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#include <wayland-client.h>
#include "ext-image-copy-capture-v1-client-protocol.h"
#include "ext-image-capture-source-v1-client-protocol.h"

static struct wl_output *output;
static struct wl_seat *seat;
static struct wl_shm *shm;
static struct ext_image_copy_capture_manager_v1 *copy_manager;
static struct ext_output_image_capture_source_manager_v1 *source_manager;
static struct ext_image_capture_source_v1 *source;
static struct wl_pointer *pointer;
static struct ext_image_copy_capture_cursor_session_v1 *cursor;
static struct ext_image_copy_capture_session_v1 *capture;
static uint32_t width, height, next_width, next_height;
static int argb;
static struct wl_buffer *buffer;
static void *pixels;
static size_t pixels_size;
static int32_t hot_x, hot_y;
static uint64_t shown_hash;
static int shown_hot_x = -1, shown_hot_y = -1;

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  if (!strcmp(interface, wl_output_interface.name) && !output) output = wl_registry_bind(registry, name, &wl_output_interface, 1);
  else if (!strcmp(interface, wl_seat_interface.name) && !seat) seat = wl_registry_bind(registry, name, &wl_seat_interface, version < 5 ? version : 5);
  else if (!strcmp(interface, wl_shm_interface.name)) shm = wl_registry_bind(registry, name, &wl_shm_interface, 1);
  else if (!strcmp(interface, ext_image_copy_capture_manager_v1_interface.name))
    copy_manager = wl_registry_bind(registry, name, &ext_image_copy_capture_manager_v1_interface, 1);
  else if (!strcmp(interface, ext_output_image_capture_source_manager_v1_interface.name))
    source_manager = wl_registry_bind(registry, name, &ext_output_image_capture_source_manager_v1_interface, 1);
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {}
static const struct wl_registry_listener registry_listener = {global, global_remove};

static void cursor_enter(void *data, struct ext_image_copy_capture_cursor_session_v1 *s) { printf("{\"enter\":true}\n"); fflush(stdout); }
static void cursor_leave(void *data, struct ext_image_copy_capture_cursor_session_v1 *s) { printf("{\"leave\":true}\n"); fflush(stdout); }
static void cursor_position(void *data, struct ext_image_copy_capture_cursor_session_v1 *s, int32_t x, int32_t y) {
  printf("{\"position\":[%d,%d]}\n", x, y);
  fflush(stdout);
}
// The compositor says the hotspot often, the same each time; a change shows with the next image.
static void cursor_hotspot(void *data, struct ext_image_copy_capture_cursor_session_v1 *s, int32_t x, int32_t y) {
  hot_x = x;
  hot_y = y;
}
static const struct ext_image_copy_capture_cursor_session_v1_listener cursor_listener = {cursor_enter, cursor_leave, cursor_position, cursor_hotspot};

static void print_image(void) {
  static const char table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const uint8_t *in = pixels;
  size_t n = (size_t)width * height * 4;
  printf("{\"image\":{\"width\":%u,\"height\":%u,\"hotspot\":[%d,%d],\"argb\":\"", width, height, hot_x, hot_y);
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16 | (i + 1 < n ? (uint32_t)in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    putchar(table[v >> 18 & 63]);
    putchar(table[v >> 12 & 63]);
    putchar(i + 1 < n ? table[v >> 6 & 63] : '=');
    putchar(i + 2 < n ? table[v & 63] : '=');
  }
  printf("\"}}\n");
  fflush(stdout);
}

static void capture_frame(void);

static void frame_transform(void *data, struct ext_image_copy_capture_frame_v1 *f, uint32_t t) {}
static void frame_damage(void *data, struct ext_image_copy_capture_frame_v1 *f, int32_t x, int32_t y, int32_t w, int32_t h) {}
static void frame_time(void *data, struct ext_image_copy_capture_frame_v1 *f, uint32_t hi, uint32_t lo, uint32_t ns) {}
static void frame_ready(void *data, struct ext_image_copy_capture_frame_v1 *f) {
  if (data != capture) {  // a frame of a session since closed
    ext_image_copy_capture_frame_v1_destroy(f);
    return;
  }
  // The compositor sends a frame again and again with the same image: only a new image, or a new hotspot, is written.
  uint64_t hash = 1469598103934665603ULL;
  const uint32_t *p = pixels;
  for (size_t i = 0; i < (size_t)width * height; i++) hash = (hash ^ p[i]) * 1099511628211ULL;
  hash ^= (uint64_t)width << 32 | height;
  if (hash != shown_hash || hot_x != shown_hot_x || hot_y != shown_hot_y) {
    shown_hash = hash;
    shown_hot_x = hot_x;
    shown_hot_y = hot_y;
    print_image();
  }
  ext_image_copy_capture_frame_v1_destroy(f);
  capture_frame();
}
// A frame can fail as the cursor's buffer changes size: the next one, with the new size, follows.
static void frame_failed(void *data, struct ext_image_copy_capture_frame_v1 *f, uint32_t reason) {
  ext_image_copy_capture_frame_v1_destroy(f);
}
static const struct ext_image_copy_capture_frame_v1_listener frame_listener = {frame_transform, frame_damage, frame_time, frame_ready, frame_failed};

static void capture_frame(void) {
  if (!buffer || !capture) return;
  struct ext_image_copy_capture_frame_v1 *frame = ext_image_copy_capture_session_v1_create_frame(capture);
  ext_image_copy_capture_frame_v1_add_listener(frame, &frame_listener, capture);
  ext_image_copy_capture_frame_v1_attach_buffer(frame, buffer);
  ext_image_copy_capture_frame_v1_damage_buffer(frame, 0, 0, width, height);
  ext_image_copy_capture_frame_v1_capture(frame);
}

static void session_size(void *data, struct ext_image_copy_capture_session_v1 *s, uint32_t w, uint32_t h) {
  next_width = w;
  next_height = h;
}
static void session_shm(void *data, struct ext_image_copy_capture_session_v1 *s, uint32_t f) {
  if (f == WL_SHM_FORMAT_ARGB8888) argb = 1;
}
static void session_dmabuf_device(void *data, struct ext_image_copy_capture_session_v1 *s, struct wl_array *d) {}
static void session_dmabuf_format(void *data, struct ext_image_copy_capture_session_v1 *s, uint32_t f, struct wl_array *m) {}
// The buffer's constraints, first and whenever the cursor's size changes: a buffer of that size, and a frame into it.
static void session_done(void *data, struct ext_image_copy_capture_session_v1 *s) {
  // A pointer with no image yet has no buffer to offer: the next constraints, with its first image, follow.
  if (!argb || !next_width || !next_height) return;
  int first = buffer == NULL;
  if (buffer && next_width == width && next_height == height) return;
  if (buffer) {
    wl_buffer_destroy(buffer);
    munmap(pixels, pixels_size);
  }
  width = next_width;
  height = next_height;
  pixels_size = (size_t)width * height * 4;
  int fd = memfd_create("bb-box-cursor", MFD_CLOEXEC);
  if (fd < 0 || ftruncate(fd, pixels_size) != 0) {
    fprintf(stderr, "cursor: no memory for the cursor's image\n");
    exit(1);
  }
  pixels = mmap(NULL, pixels_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  if (pixels == MAP_FAILED) {
    fprintf(stderr, "cursor: no memory for the cursor's image\n");
    exit(1);
  }
  struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, pixels_size);
  buffer = wl_shm_pool_create_buffer(pool, 0, width, height, width * 4, WL_SHM_FORMAT_ARGB8888);
  wl_shm_pool_destroy(pool);
  close(fd);
  if (first) capture_frame();
}
static void session_stopped(void *data, struct ext_image_copy_capture_session_v1 *s) { exit(2); }
static const struct ext_image_copy_capture_session_v1_listener session_listener = {session_size, session_shm, session_dmabuf_device, session_dmabuf_format, session_done, session_stopped};

/** Opens the cursor session, for the seat's pointer. */
static void open_session(void) {
  pointer = wl_seat_get_pointer(seat);
  cursor = ext_image_copy_capture_manager_v1_create_pointer_cursor_session(copy_manager, source, pointer);
  ext_image_copy_capture_cursor_session_v1_add_listener(cursor, &cursor_listener, NULL);
  capture = ext_image_copy_capture_cursor_session_v1_get_capture_session(cursor);
  ext_image_copy_capture_session_v1_add_listener(capture, &session_listener, NULL);
}

/** Closes it, as the seat's last pointer goes: a later one opens a new session, which sends its image again. */
static void close_session(void) {
  ext_image_copy_capture_session_v1_destroy(capture);
  ext_image_copy_capture_cursor_session_v1_destroy(cursor);
  if (wl_pointer_get_version(pointer) >= WL_POINTER_RELEASE_SINCE_VERSION) wl_pointer_release(pointer);
  else wl_pointer_destroy(pointer);
  capture = NULL;
  cursor = NULL;
  pointer = NULL;
  if (buffer) {
    wl_buffer_destroy(buffer);
    munmap(pixels, pixels_size);
    buffer = NULL;
  }
  width = height = 0;
  shown_hash = 0;
  shown_hot_x = shown_hot_y = -1;
  printf("{\"leave\":true}\n");
  fflush(stdout);
}

static void seat_capabilities(void *data, struct wl_seat *s, uint32_t caps) {
  int has = (caps & WL_SEAT_CAPABILITY_POINTER) != 0;
  if (has && !pointer) open_session();
  else if (!has && pointer) close_session();
}
static void seat_name(void *data, struct wl_seat *s, const char *name) {}
static const struct wl_seat_listener seat_listener = {seat_capabilities, seat_name};

int main(void) {
  struct wl_display *display = wl_display_connect(NULL);
  if (!display) {
    fprintf(stderr, "cursor: no Wayland display\n");
    return 1;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!output || !seat || !shm || !copy_manager || !source_manager) {
    fprintf(stderr, "cursor: the compositor lacks ext-image-copy-capture\n");
    return 1;
  }
  source = ext_output_image_capture_source_manager_v1_create_source(source_manager, output);
  wl_seat_add_listener(seat, &seat_listener, NULL);
  while (wl_display_dispatch(display) != -1) {}
  return 1;
}
