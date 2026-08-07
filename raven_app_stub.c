/* Native entry point for Raven.app.
 *
 * macOS LaunchServices inspects CFBundleExecutable to decide which
 * architecture to launch an app bundle with. A plain shell script there
 * isn't a Mach-O binary, so LaunchServices can't detect a native arm64
 * slice and falls back to offering Rosetta - even on Apple Silicon, even
 * though nothing here actually needs x86_64. Compiling this as a real
 * universal (arm64 + x86_64) Mach-O binary fixes that: it just resolves
 * its own location, walks up to the repo root, and execs the venv's
 * python on desktop_launcher.py - the same thing the old shell script did.
 *
 * Rebuild after moving/renaming things with:
 *   clang -arch x86_64 -arch arm64 -o Raven.app/Contents/MacOS/Raven raven_app_stub.c
 */
#include <mach-o/dyld.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char exec_path[PATH_MAX];
    uint32_t size = sizeof(exec_path);
    if (_NSGetExecutablePath(exec_path, &size) != 0) {
        fprintf(stderr, "Raven: could not determine executable path\n");
        return 1;
    }

    char real_path[PATH_MAX];
    if (realpath(exec_path, real_path) == NULL) {
        perror("Raven: realpath");
        return 1;
    }

    /* real_path = <repo>/Raven.app/Contents/MacOS/Raven - walk up three
     * directories (MacOS -> Contents -> Raven.app) to reach the repo root. */
    char *macos_dir = dirname(real_path);
    char *contents_dir = dirname(strdup(macos_dir));
    char *app_dir = dirname(strdup(contents_dir));
    char *repo_dir = dirname(strdup(app_dir));

    char python_path[PATH_MAX];
    char script_path[PATH_MAX];
    snprintf(python_path, sizeof(python_path), "%s/.venv/bin/python", repo_dir);
    snprintf(script_path, sizeof(script_path), "%s/desktop_launcher.py", repo_dir);

    if (chdir(repo_dir) != 0) {
        perror("Raven: chdir");
        return 1;
    }

    execl(python_path, python_path, script_path, (char *)NULL);
    perror("Raven: execl");
    return 1;
}
