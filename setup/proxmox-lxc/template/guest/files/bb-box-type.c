// bb-box-type: types text on a Wayland desktop through a virtual keyboard
// with a fixed US layout (evdev, pc105, us), so every app takes each key as
// a person's (#707). wtype makes a keymap up as it goes, and Chrome
// mishandled some of its keycodes: "/" deleted the character before it,
// and spaces went missing. Text with a character that layout lacks types
// nothing and exits 3, so the caller pastes it instead. Built by the
// Wayland desktop template (customize-desktop-wayland.sh) as
// /usr/local/libexec/bb-box/type.
//
// usage: type [delay-ms] < text   (WAYLAND_DISPLAY in the environment)
// Exits 0 when typed (empty text types nothing), 3 when the text has a
// character the layout lacks, 1 on any other failure.
#define _GNU_SOURCE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include <xkbcommon/xkbcommon.h>

// zwp_virtual_keyboard_manager_v1 and zwp_virtual_keyboard_v1, from
// wlroots' virtual-keyboard-unstable-v1.xml, written out as wayland-scanner
// would, as no package ships the XML.
extern const struct wl_interface zwp_virtual_keyboard_v1_interface;
static const struct wl_interface *manager_types[] = {&wl_seat_interface, &zwp_virtual_keyboard_v1_interface};
static const struct wl_message manager_requests[] = {{"create_virtual_keyboard", "on", manager_types}};
static const struct wl_interface zwp_virtual_keyboard_manager_v1_interface = {"zwp_virtual_keyboard_manager_v1", 1, 1, manager_requests, 0, NULL};
static const struct wl_interface *no_types[] = {NULL, NULL, NULL, NULL};
static const struct wl_message keyboard_requests[] = {
    {"keymap", "uhu", no_types}, {"key", "uuu", no_types}, {"modifiers", "uuuu", no_types}, {"destroy", "", no_types}};
const struct wl_interface zwp_virtual_keyboard_v1_interface = {"zwp_virtual_keyboard_v1", 1, 4, keyboard_requests, 0, NULL};

static struct wl_seat *seat;
static struct wl_proxy *manager;

static void global(void *data, struct wl_registry *registry, uint32_t name, const char *interface, uint32_t version) {
  (void)data;
  (void)version;
  if (!seat && strcmp(interface, wl_seat_interface.name) == 0) seat = wl_registry_bind(registry, name, &wl_seat_interface, 1);
  if (strcmp(interface, zwp_virtual_keyboard_manager_v1_interface.name) == 0)
    manager = wl_registry_bind(registry, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
}
static void global_remove(void *data, struct wl_registry *registry, uint32_t name) {
  (void)data;
  (void)registry;
  (void)name;
}
static const struct wl_registry_listener registry_listener = {global, global_remove};

// Each ASCII character's key and whether it needs Shift; key 0 is none.
static struct { xkb_keycode_t key; int shift; } keys[128];

static uint32_t now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}

static void pause_ms(int ms) {
  struct timespec t = {ms / 1000, (long)(ms % 1000) * 1000000L};
  nanosleep(&t, NULL);
}

int main(int argc, char **argv) {
  int delay = argc > 1 ? atoi(argv[1]) : 4;
  // The text, whole, before anything is typed.
  size_t size = 0, cap = 4096;
  char *text = malloc(cap);
  for (size_t n; text && (n = fread(text + size, 1, cap - size, stdin)) > 0;) {
    size += n;
    if (size == cap) text = realloc(text, cap *= 2);
  }
  if (!text) return 1;

  struct xkb_context *context = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  struct xkb_rule_names names = {.rules = "evdev", .model = "pc105", .layout = "us"};
  struct xkb_keymap *keymap = context ? xkb_keymap_new_from_names(context, &names, XKB_KEYMAP_COMPILE_NO_FLAGS) : NULL;
  if (!keymap) {
    fprintf(stderr, "bb-box-type: no US keymap\n");
    return 1;
  }
  for (xkb_keycode_t key = xkb_keymap_min_keycode(keymap); key <= xkb_keymap_max_keycode(keymap); key++) {
    for (int level = 0; level < 2; level++) {
      const xkb_keysym_t *syms;
      if (xkb_keymap_key_get_syms_by_level(keymap, key, 0, level, &syms) != 1) continue;
      uint32_t c = xkb_keysym_to_utf32(syms[0]);
      if (syms[0] == XKB_KEY_Return) c = '\n';
      if (syms[0] == XKB_KEY_Tab) c = '\t';
      if (c > 0 && c < 128 && !keys[c].key) {
        keys[c].key = key;
        keys[c].shift = level;
      }
    }
  }
  for (size_t i = 0; i < size; i++) {
    unsigned char c = (unsigned char)text[i];
    if (c >= 128 || !keys[c].key) return 3;
  }
  xkb_mod_index_t shift_index = xkb_keymap_mod_get_index(keymap, XKB_MOD_NAME_SHIFT);
  uint32_t shift_mask = shift_index == XKB_MOD_INVALID ? 0 : 1u << shift_index;

  struct wl_display *display = wl_display_connect(NULL);
  if (!display) {
    fprintf(stderr, "bb-box-type: no Wayland display\n");
    return 1;
  }
  struct wl_registry *registry = wl_display_get_registry(display);
  wl_registry_add_listener(registry, &registry_listener, NULL);
  wl_display_roundtrip(display);
  if (!seat || !manager) {
    fprintf(stderr, "bb-box-type: the compositor offers no virtual keyboard\n");
    return 1;
  }
  struct wl_proxy *keyboard =
      wl_proxy_marshal_flags(manager, 0, &zwp_virtual_keyboard_v1_interface, 1, 0, seat, NULL);

  char *map = xkb_keymap_get_as_string(keymap, XKB_KEYMAP_FORMAT_TEXT_V1);
  size_t map_size = strlen(map) + 1;
  int fd = memfd_create("bb-box-keymap", MFD_CLOEXEC);
  if (fd < 0 || write(fd, map, map_size) != (ssize_t)map_size) return 1;
  wl_proxy_marshal_flags(keyboard, 0, NULL, 1, 0, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1, fd, (uint32_t)map_size);
  wl_display_roundtrip(display);
  // A new keyboard's first key can be lost while the app takes its keymap.
  pause_ms(50);

  int shifted = 0;
  for (size_t i = 0; i < size; i++) {
    unsigned char c = (unsigned char)text[i];
    if (keys[c].shift != shifted) {
      shifted = keys[c].shift;
      wl_proxy_marshal_flags(keyboard, 2, NULL, 1, 0, shifted ? shift_mask : 0, 0, 0, 0);
    }
    uint32_t key = keys[c].key - 8;
    wl_proxy_marshal_flags(keyboard, 1, NULL, 1, 0, now_ms(), key, WL_KEYBOARD_KEY_STATE_PRESSED);
    wl_display_flush(display);
    pause_ms(delay);
    wl_proxy_marshal_flags(keyboard, 1, NULL, 1, 0, now_ms(), key, WL_KEYBOARD_KEY_STATE_RELEASED);
    wl_display_flush(display);
    pause_ms(delay);
  }
  if (shifted) wl_proxy_marshal_flags(keyboard, 2, NULL, 1, 0, 0, 0, 0, 0);
  wl_display_roundtrip(display);
  wl_proxy_marshal_flags(keyboard, 3, NULL, 1, WL_MARSHAL_FLAG_DESTROY);
  wl_display_roundtrip(display);
  wl_display_disconnect(display);
  return 0;
}
