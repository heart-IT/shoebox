cmake_minimum_required(VERSION 3.22.1)
project(Shoebox)

# The generated autolinking file adds all Nitrogen sources to this target and
# resolves its paths relative to this file (../nitrogen -> app/nitrogen).
add_library(Shoebox SHARED
  cpp-adapter.cpp
)

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/Shoebox+autolinking.cmake)
