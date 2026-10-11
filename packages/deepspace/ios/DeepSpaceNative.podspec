require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'DeepSpaceNative'
  s.version        = package['version']
  s.summary        = 'Keyboard shortcuts, context menus and Mac detection for deepspace/native'
  s.description    = 'UIKit pieces React Native does not expose: app-wide UIKeyCommands, UIContextMenuInteraction, and isiOSAppOnMac.'
  s.author         = 'DeepSpace'
  s.homepage       = 'https://deep.space'
  s.license        = { :type => 'Apache-2.0' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: 'https://github.com/deepdotspace/deepspace.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = '**/*.{h,m,mm,swift}'
end
