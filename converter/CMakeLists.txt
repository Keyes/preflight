cmake_minimum_required(VERSION 3.20)
project(skp2glb LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

set(SDK_DIR "${CMAKE_CURRENT_LIST_DIR}/../SketchUp_SDK")

# Put the programs straight into the build folder for every configuration (Visual Studio would otherwise use
# build/Release/), which is where the server looks for them.
foreach(config IN ITEMS "" _DEBUG _RELEASE _RELWITHDEBINFO _MINSIZEREL)
  set(CMAKE_RUNTIME_OUTPUT_DIRECTORY${config} "${CMAKE_BINARY_DIR}")
endforeach()

if(APPLE)
  function(link_sketchup target)
    target_compile_options(${target} PRIVATE -F${SDK_DIR})
    target_link_options(${target} PRIVATE -F${SDK_DIR} -framework SketchUpAPI
      -Wl,-rpath,${SDK_DIR})
  endfunction()
elseif(WIN32)
  # Untested so far. The Windows SDK keeps headers in headers/ and the 64-bit libraries in binaries/sketchup/x64/.
  set(SDK_BIN "${SDK_DIR}/binaries/sketchup/x64")
  if(NOT EXISTS "${SDK_BIN}/SketchUpAPI.lib")
    message(FATAL_ERROR "SketchUp SDK not found: expected ${SDK_BIN}/SketchUpAPI.lib (unpack the Windows SDK as SketchUp_SDK/)")
  endif()
  file(GLOB SDK_DLLS "${SDK_BIN}/*.dll")
  function(link_sketchup target)
    target_include_directories(${target} PRIVATE "${SDK_DIR}/headers")
    target_link_libraries(${target} PRIVATE "${SDK_BIN}/SketchUpAPI.lib")
    # The program loads SketchUpAPI.dll and its companions from its own folder.
    add_custom_command(TARGET ${target} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E copy_if_different ${SDK_DLLS} $<TARGET_FILE_DIR:${target}>)
  endfunction()
else()
  message(FATAL_ERROR "The SketchUp C SDK is only published for macOS and Windows, so the converter cannot be built here. See the README for how to get venues in on Linux.")
endif()

add_executable(probe probe.cpp)
link_sketchup(probe)

add_executable(skp2glb skp2glb.cpp)
link_sketchup(skp2glb)
