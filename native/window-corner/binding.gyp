{
  "targets": [
    {
      "target_name": "window_corner",
      "sources": [ "src/window_corner.mm" ],
      "conditions": [
        ["OS=='mac'", {
          "xcode_settings": {
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "11.0"
          },
          "link_settings": {
            "libraries": [
              "$(SDKROOT)/System/Library/Frameworks/Cocoa.framework",
              "$(SDKROOT)/System/Library/Frameworks/QuartzCore.framework"
            ]
          }
        }]
      ]
    }
  ]
}
