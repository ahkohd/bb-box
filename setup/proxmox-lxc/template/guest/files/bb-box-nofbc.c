// bb-box: no NvFBC for Selkies on the GPU display path (#863). Selkies'
// capture (pixelflux) tries NVIDIA's zero-copy capture, NvFBC, before it
// takes the X server's shared memory. On bb-box's X screen, which has no
// display attached (UseDisplayDevice none), NvFBC never answers, and
// pixelflux waits 5 s for it at each capture's start: a viewer's first frame
// came 5.1 s after it asked. With libnvidia-fbc not loading, pixelflux
// declines it at once, and the first frame came in 0.15 s, still encoded
// with NVENC. Selkies' launcher preloads this on the GPU path only.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stddef.h>
#include <string.h>

void *dlopen(const char *file, int flags) {
  static void *(*real)(const char *, int);
  if (!real) real = (void *(*)(const char *, int))dlsym(RTLD_NEXT, "dlopen");
  if (file && strstr(file, "libnvidia-fbc")) return NULL;
  return real(file, flags);
}
