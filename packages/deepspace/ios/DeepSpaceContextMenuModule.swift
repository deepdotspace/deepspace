import ExpoModulesCore
import UIKit

struct ContextMenuItemSpec: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  /// An SF Symbol name.
  @Field var icon: String?
  @Field var destructive: Bool = false
  @Field var disabled: Bool = false
}

public class DeepSpaceContextMenuModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DeepSpaceContextMenu")

    View(ContextMenuView.self) {
      Events("onSelect")
      Prop("items") { (view: ContextMenuView, items: [ContextMenuItemSpec]) in
        view.items = items
      }
      Prop("enabled") { (view: ContextMenuView, enabled: Bool) in
        view.setMenuEnabled(enabled)
      }
    }
  }
}

/// The native context menu for what it wraps: a secondary click on a Mac, touch and hold on iPhone and iPad.
public class ContextMenuView: ExpoView, UIContextMenuInteractionDelegate {
  let onSelect = EventDispatcher()
  var items: [ContextMenuItemSpec] = []
  private var interaction: UIContextMenuInteraction?

  func setMenuEnabled(_ enabled: Bool) {
    if enabled, interaction == nil {
      let added = UIContextMenuInteraction(delegate: self)
      addInteraction(added)
      interaction = added
    } else if !enabled, let existing = interaction {
      removeInteraction(existing)
      interaction = nil
    }
  }

  public func contextMenuInteraction(
    _ interaction: UIContextMenuInteraction,
    configurationForMenuAtLocation location: CGPoint
  ) -> UIContextMenuConfiguration? {
    let specs = items
    if specs.isEmpty { return nil }
    return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      let actions = specs.map { spec -> UIAction in
        var attributes: UIMenuElement.Attributes = []
        if spec.destructive { attributes.insert(.destructive) }
        if spec.disabled { attributes.insert(.disabled) }
        let image = spec.icon.flatMap { UIImage(systemName: $0) }
        return UIAction(title: spec.title, image: image, attributes: attributes) { _ in
          self?.onSelect(["id": spec.id])
        }
      }
      return UIMenu(children: actions)
    }
  }
}
