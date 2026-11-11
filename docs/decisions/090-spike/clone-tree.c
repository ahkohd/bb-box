#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/attr.h>
#include <sys/clonefile.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: clone-tree <source> <destination>\n");
    return 2;
  }
  if (clonefile(argv[1], argv[2], CLONE_NOFOLLOW) != 0) {
    fprintf(stderr, "clonefile %s %s: %s\n", argv[1], argv[2], strerror(errno));
    return 1;
  }
  return 0;
}
