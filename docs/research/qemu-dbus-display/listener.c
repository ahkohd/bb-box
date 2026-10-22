/* Throwaway (#885 spike): QEMU D-Bus display listener over p2p, logging each call with a monotonic time.
 * usage: listener <vm dir> <log> <seconds> [keytest] [map]   (map: advertise Unix.Map) */
#include <gio/gio.h>
#include <gio/gunixfdlist.h>
#include <gio/gunixsocketaddress.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static FILE *logf;
static gint64 t0;
static long updates, area, scanouts, bytes_total;
static gboolean advertise_map;
static double now(void) { return (g_get_monotonic_time() - t0) / 1e6; }

static const char *XML =
  "<node>"
  "<interface name='org.qemu.Display1.Listener'>"
  "<method name='Scanout'><arg type='u' direction='in'/><arg type='u' direction='in'/><arg type='u' direction='in'/><arg type='u' direction='in'/><arg type='ay' direction='in'/></method>"
  "<method name='Update'><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='u' direction='in'/><arg type='u' direction='in'/><arg type='ay' direction='in'/></method>"
  "<method name='Disable'/>"
  "<method name='MouseSet'><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
  "<method name='CursorDefine'><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='ay' direction='in'/></method>"
  "<property name='Interfaces' type='as' access='read'/>"
  "</interface>"
  "<interface name='org.qemu.Display1.Listener.Unix.Map'>"
  "<method name='ScanoutMap'><arg type='h' direction='in'/><arg type='u' direction='in'/><arg type='u' direction='in'/><arg type='u' direction='in'/><arg type='u' direction='in'/><arg type='u' direction='in'/></method>"
  "<method name='UpdateMap'><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='i' direction='in'/><arg type='i' direction='in'/></method>"
  "</interface></node>";

static void on_call(GDBusConnection *c, const gchar *sender, const gchar *path, const gchar *iface, const gchar *method, GVariant *p, GDBusMethodInvocation *inv, gpointer u) {
  double t = now();
  if (!strcmp(method, "Update")) {
    gint32 x, y, w, h; guint32 stride, fmt; GVariant *data;
    g_variant_get(p, "(iiiiuu@ay)", &x, &y, &w, &h, &stride, &fmt, &data);
    updates++; area += (long)w * h; bytes_total += g_variant_get_size(data);
    fprintf(logf, "%.6f Update %d %d %d %d %zu\n", t, x, y, w, h, g_variant_get_size(data));
    g_variant_unref(data);
  } else if (!strcmp(method, "UpdateMap")) {
    gint32 x, y, w, h; g_variant_get(p, "(iiii)", &x, &y, &w, &h);
    updates++; area += (long)w * h;
    fprintf(logf, "%.6f UpdateMap %d %d %d %d\n", t, x, y, w, h);
  } else if (!strcmp(method, "Scanout")) {
    guint32 w, h, stride, fmt; GVariant *data;
    g_variant_get(p, "(uuuu@ay)", &w, &h, &stride, &fmt, &data); scanouts++;
    fprintf(logf, "%.6f Scanout %u %u %u 0x%x %zu\n", t, w, h, stride, fmt, g_variant_get_size(data));
    g_variant_unref(data);
  } else if (!strcmp(method, "ScanoutMap")) {
    gint32 idx; guint32 off, w, h, stride, fmt; g_variant_get(p, "(huuuuu)", &idx, &off, &w, &h, &stride, &fmt); scanouts++;
    GUnixFDList *fds = g_dbus_message_get_unix_fd_list(g_dbus_method_invocation_get_message(inv));
    int fd = fds ? g_unix_fd_list_get(fds, idx, NULL) : -1;
    void *m = fd >= 0 ? mmap(NULL, (size_t)stride * h, PROT_READ, MAP_SHARED, fd, off) : MAP_FAILED;
    fprintf(logf, "%.6f ScanoutMap %u %u %u 0x%x fd %d mmap %s\n", t, w, h, stride, fmt, fd, m == MAP_FAILED ? "failed" : "ok");
  } else {
    gchar *s = g_variant_print(p, FALSE);
    fprintf(logf, "%.6f %s %.120s\n", t, method, s); g_free(s);
  }
  g_dbus_method_invocation_return_value(inv, NULL);
}

static GVariant *on_get(GDBusConnection *c, const gchar *sender, const gchar *path, const gchar *iface, const gchar *prop, GError **err, gpointer u) {
  const gchar *map[] = {"org.qemu.Display1.Listener.Unix.Map", NULL};
  const gchar *none[] = {NULL};
  return g_variant_new_strv(advertise_map ? map : none, -1);
}

static GDBusConnection *display;
static int key_left;
static gboolean press_key(gpointer u) {
  static guint codes[] = {0x1e, 0x0e}; /* a, backspace */
  guint code = codes[key_left % 2];
  fprintf(logf, "%.6f KeyPress 0x%x\n", now(), code);
  g_dbus_connection_call(display, NULL, "/org/qemu/Display1/Console_0", "org.qemu.Display1.Keyboard", "Press", g_variant_new("(u)", code), NULL, 0, -1, NULL, NULL, NULL);
  g_dbus_connection_call(display, NULL, "/org/qemu/Display1/Console_0", "org.qemu.Display1.Keyboard", "Release", g_variant_new("(u)", code), NULL, 0, -1, NULL, NULL, NULL);
  return --key_left > 0;
}
static int mouse_left;
static gboolean move_mouse(gpointer u) {
  guint x = 200 + (mouse_left % 20) * 40, y = 300 + (mouse_left % 7) * 30;
  fprintf(logf, "%.6f MouseMove %u %u\n", now(), x, y);
  g_dbus_connection_call(display, NULL, "/org/qemu/Display1/Console_0", "org.qemu.Display1.Mouse", "SetAbsPosition", g_variant_new("(uu)", x, y), NULL, 0, -1, NULL, NULL, NULL);
  return --mouse_left > 0;
}
static gboolean resize_once(gpointer u) {
  fprintf(logf, "%.6f SetUIInfo 1600 900\n", now());
  GError *e = NULL;
  GVariant *r = g_dbus_connection_call_sync(display, NULL, "/org/qemu/Display1/Console_0", "org.qemu.Display1.Console", "SetUIInfo",
    g_variant_new("(qqiiuu)", 423, 238, 0, 0, 1600, 900), NULL, 0, 5000, NULL, &e);
  fprintf(logf, "%.6f SetUIInfo reply %s\n", now(), r ? "ok" : e->message);
  return FALSE;
}
static gboolean per_second(gpointer u) {
  static long last; printf("%.0f s: %ld updates (+%ld), %ld scanouts, %.1f MB\n", now(), updates, updates - last, scanouts, bytes_total / 1e6); last = updates; fflush(stdout); fflush(logf); return TRUE;
}
static gboolean quit(gpointer loop) { g_main_loop_quit(loop); return FALSE; }

static gpointer register_thread(gpointer fds) {
  GError *e = NULL;
  GVariant *r = g_dbus_connection_call_with_unix_fd_list_sync(display, NULL, "/org/qemu/Display1/Console_0", "org.qemu.Display1.Console", "RegisterListener",
    g_variant_new("(h)", 0), NULL, 0, 10000, fds, NULL, NULL, &e);
  printf("RegisterListener: %s\n", r ? "ok" : e->message); fflush(stdout);
  return NULL;
}

static int qmp(int s, const char *cmd, int fd) {
  struct msghdr mh = {0}; struct iovec io = {(void *)cmd, strlen(cmd)}; char cbuf[CMSG_SPACE(sizeof(int))];
  mh.msg_iov = &io; mh.msg_iovlen = 1;
  if (fd >= 0) { mh.msg_control = cbuf; mh.msg_controllen = sizeof cbuf; struct cmsghdr *c = CMSG_FIRSTHDR(&mh); c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int)); memcpy(CMSG_DATA(c), &fd, sizeof fd); }
  sendmsg(s, &mh, 0); char buf[4096]; ssize_t n = read(s, buf, sizeof buf - 1); buf[n > 0 ? n : 0] = 0; printf("qmp: %s", buf); return 0;
}

int main(int argc, char **argv) {
  t0 = g_get_monotonic_time();
  logf = fopen(argv[2], "w");
  int seconds = atoi(argv[3]);
  int keytest = argc > 4 ? atoi(argv[4]) : 0;
  advertise_map = argc > 5 && atoi(argv[5]);
  int q = socket(AF_UNIX, SOCK_STREAM, 0); struct sockaddr_un a = {.sun_family = AF_UNIX};
  snprintf(a.sun_path, sizeof a.sun_path, "%s/qmp", argv[1]);
  if (connect(q, (void *)&a, sizeof a)) { perror("qmp"); return 1; }
  char greet[4096]; read(q, greet, sizeof greet);
  qmp(q, "{\"execute\":\"qmp_capabilities\"}", -1);
  int pair[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, pair);
  qmp(q, "{\"execute\":\"getfd\",\"arguments\":{\"fdname\":\"dbus\"}}", pair[1]);
  qmp(q, "{\"execute\":\"add_client\",\"arguments\":{\"protocol\":\"@dbus-display\",\"fdname\":\"dbus\"}}", -1);
  close(pair[1]);
  GError *err = NULL;
  GSocket *gs = g_socket_new_from_fd(pair[0], &err);
  GIOStream *st = G_IO_STREAM(g_socket_connection_factory_create_connection(gs));
  display = g_dbus_connection_new_sync(st, NULL, G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT, NULL, NULL, &err);
  if (!display) { printf("display: %s\n", err->message); return 1; }
  printf("display connection up\n");
  /* The listener's socket: QEMU connects to it as a client once RegisterListener arrives. */
  int lp[2]; socketpair(AF_UNIX, SOCK_STREAM, 0, lp);
  GUnixFDList *fds = g_unix_fd_list_new(); g_unix_fd_list_append(fds, lp[1], NULL); close(lp[1]);
  GVariant *intro = g_dbus_connection_call_sync(display, NULL, "/org/qemu/Display1", "org.freedesktop.DBus.Introspectable", "Introspect", NULL, NULL, 0, 5000, NULL, &err);
  if (intro) { const gchar *x; g_variant_get(intro, "(&s)", &x); printf("introspect /org/qemu/Display1: %.400s\n", x); } else { printf("introspect: %s\n", err->message); g_clear_error(&err); }
  g_thread_new("register", register_thread, fds);
  GSocket *ls = g_socket_new_from_fd(lp[0], &err);
  GIOStream *lst = G_IO_STREAM(g_socket_connection_factory_create_connection(ls));
  gchar *guid = g_dbus_generate_guid();
  GDBusConnection *listener = g_dbus_connection_new_sync(lst, NULL, G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_DELAY_MESSAGE_PROCESSING, NULL, NULL, &err);
  if (!listener) { printf("listener: %s\n", err->message); return 1; }
  GDBusNodeInfo *node = g_dbus_node_info_new_for_xml(XML, &err);
  static const GDBusInterfaceVTable vt = {on_call, on_get, NULL};
  for (int i = 0; node->interfaces[i]; i++)
    g_dbus_connection_register_object(listener, "/org/qemu/Display1/Listener", node->interfaces[i], &vt, NULL, NULL, &err);
  g_dbus_connection_start_message_processing(listener);
  printf("listener up\n"); fflush(stdout);
  GMainLoop *loop = g_main_loop_new(NULL, FALSE);
  g_timeout_add_seconds(1, per_second, NULL);
  if (keytest == 1) { key_left = 20; g_timeout_add(1000, press_key, NULL); }
  if (keytest == 3) g_timeout_add(500, resize_once, NULL);
  if (keytest == 2) { mouse_left = 40; g_timeout_add(100, move_mouse, NULL); }
  g_timeout_add_seconds(seconds, quit, loop);
  g_main_loop_run(loop);
  printf("done: %ld updates, area %ld px, %ld scanouts, %.1f MB in %d s\n", updates, area, scanouts, bytes_total / 1e6, seconds);
  return 0;
}
