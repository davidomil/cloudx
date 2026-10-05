#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/syscall.h>
#include <unistd.h>

static const char *workspace;
static const char *source_file;

static void *hold_workspace(void *unused) {
  (void)unused;
  if (chdir(workspace) != 0) _exit(2);
  int descriptor = open(source_file, O_RDONLY);
  if (descriptor < 0) _exit(3);
  printf("%ld %d\n", syscall(SYS_gettid), descriptor);
  fflush(stdout);
  char release;
  if (read(STDIN_FILENO, &release, 1) != 1) _exit(4);
  close(descriptor);
  return NULL;
}

int main(int argc, char **argv) {
  if (argc != 3) return 1;
  workspace = argv[1];
  source_file = argv[2];
  pthread_t thread;
  if (pthread_create(&thread, NULL, hold_workspace, NULL) != 0) return 5;
  pthread_exit(NULL);
}
