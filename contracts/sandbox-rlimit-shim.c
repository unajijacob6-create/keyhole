/*
 * Test-only LD_PRELOAD shim for the NEAR sandbox node.
 *
 * near-sandbox (neard) aborts at startup unless it can raise RLIMIT_NOFILE to 65535.
 * Some CI containers cap the hard limit lower (this one: 20000) and do not grant
 * CAP_SYS_RESOURCE. The shim clamps that one request to the current hard limit so the
 * node starts; a 20k descriptor limit is plenty for a single-node test sandbox.
 *
 * Build: cc -shared -fPIC -O2 -o contracts/target/librlimit_shim.so contracts/sandbox-rlimit-shim.c -ldl
 * Use:   LD_PRELOAD=$PWD/contracts/target/librlimit_shim.so cargo test (contracts/test.sh does this)
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <sys/resource.h>
#include <stddef.h>

typedef int (*setrlimit_fn)(__rlimit_resource_t, const struct rlimit *);
typedef int (*setrlimit64_fn)(__rlimit_resource_t, const struct rlimit64 *);

static int clamp_and_call(__rlimit_resource_t resource, const struct rlimit *rlim, setrlimit_fn real) {
    if (resource == RLIMIT_NOFILE) {
        struct rlimit cur;
        if (getrlimit(RLIMIT_NOFILE, &cur) == 0) {
            struct rlimit want = *rlim;
            if (want.rlim_max > cur.rlim_max) want.rlim_max = cur.rlim_max;
            if (want.rlim_cur > want.rlim_max) want.rlim_cur = want.rlim_max;
            return real(resource, &want);
        }
    }
    return real(resource, rlim);
}

int setrlimit(__rlimit_resource_t resource, const struct rlimit *rlim) {
    setrlimit_fn real = (setrlimit_fn)dlsym(RTLD_NEXT, "setrlimit");
    return clamp_and_call(resource, rlim, real);
}

int setrlimit64(__rlimit_resource_t resource, const struct rlimit64 *rlim) {
    setrlimit64_fn real = (setrlimit64_fn)dlsym(RTLD_NEXT, "setrlimit64");
    if (resource == RLIMIT_NOFILE) {
        struct rlimit64 cur;
        if (getrlimit64(RLIMIT_NOFILE, &cur) == 0) {
            struct rlimit64 want = *rlim;
            if (want.rlim_max > cur.rlim_max) want.rlim_max = cur.rlim_max;
            if (want.rlim_cur > want.rlim_max) want.rlim_cur = want.rlim_max;
            return real(resource, &want);
        }
    }
    return real(resource, rlim);
}
