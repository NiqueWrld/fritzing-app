# Android (arm64-v8a) build configuration for Fritzing.
#
# Replaces the desktop dependency-detect scripts (openssl3, libgit2detect,
# quazipdetect, clipper1detect), which rely on pkg-config/uname and host paths.
#
# Expected layout of cross-compiled dependencies (override with
#   qmake ANDROID_DEPS=/path/to/deps):
#   $$ANDROID_DEPS/<abi>/openssl/{include,lib}   libssl_3.so libcrypto_3.so
#   $$ANDROID_DEPS/<abi>/libgit2/{include,lib}   libgit2.a (static)
#   $$ANDROID_DEPS/<abi>/quazip/{include,lib}    libquazip1-qt6.a (static)
#   $$ANDROID_DEPS/<abi>/clipper1/{include,lib}  libpolyclipping.a (static)
# Header-only deps (boost, svgpp, ngspice headers) use the normal detect scripts.

message("Configuring Fritzing for Android")

isEmpty(ANDROID_DEPS): ANDROID_DEPS = $$absolute_path($$PWD/../../android-deps)
isEmpty(ANDROID_TARGET_ARCH): ANDROID_TARGET_ARCH = arm64-v8a
ANDROID_ABIS = $$ANDROID_TARGET_ARCH
DEPS_ABI = $$ANDROID_DEPS/$$ANDROID_TARGET_ARCH

defineTest(requireAndroidDep) {
	dep = $$1
	exists($$DEPS_ABI/$$dep/include) {
		message("android: found $$dep in $$DEPS_ABI/$$dep")
	} else {
		error("android: $$dep not found in $$DEPS_ABI/$$dep (cross-compile it for $$ANDROID_TARGET_ARCH first)")
	}
}

requireAndroidDep(openssl)
requireAndroidDep(libgit2)
requireAndroidDep(quazip)
requireAndroidDep(clipper1)

INCLUDEPATH += \
	$$DEPS_ABI/openssl/include \
	$$DEPS_ABI/libgit2/include \
	$$DEPS_ABI/quazip/include/QuaZip-Qt6-1.4 \
	$$DEPS_ABI/clipper1/include/polyclipping

# quazipdetect.pri normally adds this; zlib itself comes from the NDK (-lz).
SOURCES += src/zlibdummy.c

LIBS += \
	$$DEPS_ABI/libgit2/lib/libgit2.a \
	$$DEPS_ABI/quazip/lib/libquazip1-qt6.a \
	$$DEPS_ABI/clipper1/lib/libpolyclipping.a \
	$$DEPS_ABI/openssl/lib/libssl_3.so \
	$$DEPS_ABI/openssl/lib/libcrypto_3.so \
	-lz

# OpenSSL 3 (KDAB android_openssl builds, *_3.so names that Qt Network loads);
# shared so Qt Network can use it too, shipped in the APK.
ANDROID_EXTRA_LIBS += \
	$$DEPS_ABI/openssl/lib/libssl_3.so \
	$$DEPS_ABI/openssl/lib/libcrypto_3.so

# QuaZip (static) needs Qt5Compat on Qt 6.
QT += core5compat

DEFINES += LINUX_64 FRITZING_ANDROID

# Android packaging sources: manifest (package org.fritzing.Fritzing) and launcher icons.
ANDROID_PACKAGE_SOURCE_DIR = $$PWD/../android
ANDROID_VERSION_NAME = 1.0.6
ANDROID_VERSION_CODE = 2
