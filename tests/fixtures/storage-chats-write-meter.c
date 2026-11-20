/*
 * LD_PRELOAD write meter for tests/storage-chats-write-bytes.test.js.
 *
 * Interposes the libc write family and appends one line `W<TAB>bytes<TAB>path` to $METER_LOG for every
 * completed write whose descriptor resolves to a file under $METER_DIR. Only positive return values are
 * logged, so short writes are counted by what was actually written and every overwrite of the same offset is
 * counted again. Memory-mapped writes (the -shm file) are not syscalls and are not part of DB + WAL bytes.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <unistd.h>

static int log_fd = -2;
static const char *prefix = NULL;

static void init_meter(void) {
  if (log_fd != -2) return;
  const char *log = getenv("METER_LOG");
  prefix = getenv("METER_DIR");
  log_fd = (log && prefix) ? (int)syscall(SYS_openat, AT_FDCWD, log, O_WRONLY | O_APPEND | O_CREAT, 0600) : -1;
}

static void record(int fd, ssize_t n) {
  if (n <= 0) return;
  init_meter();
  if (log_fd < 0 || fd == log_fd) return;
  char link[64];
  char path[PATH_MAX];
  snprintf(link, sizeof link, "/proc/self/fd/%d", fd);
  ssize_t len = syscall(SYS_readlink, link, path, sizeof path - 1);
  if (len <= 0) return;
  path[len] = 0;
  if (strncmp(path, prefix, strlen(prefix)) != 0) return;
  char line[PATH_MAX + 48];
  int out = snprintf(line, sizeof line, "W\t%zd\t%s\n", n, path);
  syscall(SYS_write, log_fd, line, (size_t)out);
}

#define REAL(name) static __typeof__(&name) real = NULL; if (!real) real = dlsym(RTLD_NEXT, #name)

ssize_t write(int fd, const void *buf, size_t count) { REAL(write); ssize_t r = real(fd, buf, count); record(fd, r); return r; }
ssize_t pwrite(int fd, const void *buf, size_t count, off_t off) { REAL(pwrite); ssize_t r = real(fd, buf, count, off); record(fd, r); return r; }
ssize_t pwrite64(int fd, const void *buf, size_t count, off64_t off) { REAL(pwrite64); ssize_t r = real(fd, buf, count, off); record(fd, r); return r; }
ssize_t writev(int fd, const struct iovec *iov, int cnt) { REAL(writev); ssize_t r = real(fd, iov, cnt); record(fd, r); return r; }
ssize_t pwritev(int fd, const struct iovec *iov, int cnt, off_t off) { REAL(pwritev); ssize_t r = real(fd, iov, cnt, off); record(fd, r); return r; }
ssize_t pwritev64(int fd, const struct iovec *iov, int cnt, off64_t off) { REAL(pwritev64); ssize_t r = real(fd, iov, cnt, off); record(fd, r); return r; }
ssize_t pwritev2(int fd, const struct iovec *iov, int cnt, off_t off, int flags) { REAL(pwritev2); ssize_t r = real(fd, iov, cnt, off, flags); record(fd, r); return r; }
