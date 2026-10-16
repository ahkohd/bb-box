/*
 * bb-box-own: runs a program as its own responsible process (058).
 *
 *   bb-box-own <program> [arguments...]
 *
 * macOS checks a program's permissions (Accessibility, Screen Recording and
 * the rest) against its responsible process. A command run over SSH is
 * charged to sshd-keygen-wrapper, so the permissions bb-box grants a program
 * apply only when the program is its own responsible process. This starts it
 * so, as Terminal does, and passes on its exit status. setup-mac.sh compiles
 * it into /usr/local/bin.
 */
#include <spawn.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>

extern char **environ;
/* libSystem's, as Terminal and other launchers use it. */
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: bb-box-own <program> [arguments...]\n");
    return 2;
  }
  posix_spawnattr_t attrs;
  if (posix_spawnattr_init(&attrs) != 0 || responsibility_spawnattrs_setdisclaim(&attrs, 1) != 0) {
    fprintf(stderr, "bb-box-own: could not disclaim responsibility\n");
    return 1;
  }
  pid_t pid;
  int error = posix_spawnp(&pid, argv[1], NULL, &attrs, argv + 1, environ);
  if (error != 0) {
    fprintf(stderr, "bb-box-own: %s: %s\n", argv[1], strerror(error));
    return 127;
  }
  int status;
  if (waitpid(pid, &status, 0) < 0) return 1;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  return 128 + WTERMSIG(status);
}
