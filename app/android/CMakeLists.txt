cmake_minimum_required(VERSION 3.22.1)
project(appmodules)

# Nitro headers require C++20 (std::remove_cvref_t, auto in prototypes)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Default RN app library (autolinked TurboModules + codegen). Bridgeless
# startup hard-requires libappmodules.so — replacing it with a custom-only
# target dies at boot with "couldn't find DSO to load: libappmodules.so".
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)

# The Nitro library, kept separate: the generated autolinking file attaches
# all Nitrogen sources to this target and resolves its paths relative to
# this file (../nitrogen -> app/nitrogen). Its JNI_OnLoad lives in
# ShoeboxOnLoad.cpp; the Kotlin side loads libShoebox.so on demand.
# cpp-adapter lives in nitro/ deliberately: ReactNative-application.cmake
# globs *.cpp NEXT TO THIS FILE and, if any exist, swaps out its
# default-app-setup sources (the TurboModule delegate OnLoad) for them —
# silently breaking every TurboModule at boot.
add_library(Shoebox SHARED
  nitro/cpp-adapter.cpp
  # Movement 3: the hand-rolled C++ mmap HybridObject. The generated
  # ShoeboxOnLoad.cpp #includes and constructs it, so both the source and its
  # header directory must reach this target.
  ../cpp/HybridShoeboxBytes.cpp
)

# app/cpp holds the hand-written C++ HybridObject impl + header.
target_include_directories(Shoebox PRIVATE ${CMAKE_SOURCE_DIR}/../cpp)

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/Shoebox+autolinking.cmake)
