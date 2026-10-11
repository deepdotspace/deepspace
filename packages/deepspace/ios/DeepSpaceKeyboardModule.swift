import ExpoModulesCore
import UIKit

/// One key combination the app listens for (`ShortcutSpec` in shortcuts.ts).
struct ShortcutSpec: Record {
  /// Reported back when pressed, e.g. "command+k".
  @Field var id: String = ""
  /// A named key (space, return, escape, tab, delete, up, down, left, right) or one character.
  @Field var key: String = ""
  /// Any of: command, shift, option, control.
  @Field var modifiers: [String] = []
  /// Also applies while a text field inside the root is being typed in.
  @Field var whileTyping: Bool = false
  /// Shown in the iPad keyboard-shortcut overlay (hold Command).
  @Field var title: String?
}

public class DeepSpaceKeyboardModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DeepSpaceKeyboard")

    // The iPad build runs unchanged on Apple silicon Macs, where input is a
    // pointer and a keyboard.
    Constant("isIOSAppOnMac") {
      ProcessInfo.processInfo.isiOSAppOnMac
    }

    View(KeyboardShortcutsView.self) {
      Events("onShortcut")
      Prop("shortcuts") { (view: KeyboardShortcutsView, shortcuts: [ShortcutSpec]) in
        view.setShortcuts(shortcuts)
      }
    }
  }
}

/**
 The app's root. It takes keyboard focus whenever nothing else has it, so
 shortcuts work with nothing selected. While a text field inside is first
 responder, the field gets the keys and only `whileTyping` shortcuts apply
 (UIKit asks every responder up the chain); when the field lets go, the root
 takes focus back.
 */
public class KeyboardShortcutsView: ExpoView {
  let onShortcut = EventDispatcher()
  private var all: [UIKeyCommand] = []
  private var whileTyping: [UIKeyCommand] = []
  private var observers: [NSObjectProtocol] = []

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    let reclaim: (Notification) -> Void = { [weak self] _ in self?.reclaimFocusSoon() }
    for name in [
      UITextField.textDidEndEditingNotification,
      UITextView.textDidEndEditingNotification,
      UIApplication.didBecomeActiveNotification,
    ] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main, using: reclaim))
    }
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  func setShortcuts(_ specs: [ShortcutSpec]) {
    all = specs.compactMap(KeyboardShortcutsView.command)
    let typingIds = Set(specs.filter(\.whileTyping).map(\.id))
    whileTyping = all.filter { typingIds.contains($0.propertyList as? String ?? "") }
  }

  public override var canBecomeFirstResponder: Bool { true }

  public override var keyCommands: [UIKeyCommand]? {
    isFirstResponder ? all : whileTyping
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    reclaimFocusSoon()
  }

  /// Takes focus after the current event, unless something else (a text field) has it by then.
  private func reclaimFocusSoon() {
    DispatchQueue.main.async { [weak self] in
      guard let self, self.window != nil, !self.isFirstResponder, FirstResponder.current() == nil else { return }
      self.becomeFirstResponder()
    }
  }

  @objc func handle(_ sender: UIKeyCommand) {
    guard let id = sender.propertyList as? String else { return }
    onShortcut(["id": id, "typing": !isFirstResponder])
  }

  static func command(_ spec: ShortcutSpec) -> UIKeyCommand? {
    guard let input = input(spec.key) else { return nil }
    var flags: UIKeyModifierFlags = []
    for modifier in spec.modifiers {
      switch modifier {
      case "command": flags.insert(.command)
      case "shift": flags.insert(.shift)
      case "option": flags.insert(.alternate)
      case "control": flags.insert(.control)
      default: break
      }
    }
    let command = UIKeyCommand(
      title: spec.title ?? "",
      action: #selector(handle(_:)),
      input: input,
      modifierFlags: flags,
      propertyList: spec.id
    )
    // Space, Return, Tab and the arrows would otherwise scroll, press the focused control, or move focus.
    command.wantsPriorityOverSystemBehavior = true
    return command
  }

  static func input(_ key: String) -> String? {
    switch key {
    case "space": return " "
    case "return": return "\r"
    case "escape": return UIKeyCommand.inputEscape
    case "tab": return "\t"
    case "delete": return "\u{8}"
    case "up": return UIKeyCommand.inputUpArrow
    case "down": return UIKeyCommand.inputDownArrow
    case "left": return UIKeyCommand.inputLeftArrow
    case "right": return UIKeyCommand.inputRightArrow
    default: return key.isEmpty ? nil : key
    }
  }
}

/// The current first responder: UIKit sends a target-less action to it.
enum FirstResponder {
  private static weak var found: UIResponder?

  static func current() -> UIResponder? {
    found = nil
    UIApplication.shared.sendAction(#selector(UIResponder.deepspace_markFirstResponder), to: nil, from: nil, for: nil)
    return found
  }

  fileprivate static func mark(_ responder: UIResponder) {
    found = responder
  }
}

extension UIResponder {
  @objc fileprivate func deepspace_markFirstResponder() {
    FirstResponder.mark(self)
  }
}
