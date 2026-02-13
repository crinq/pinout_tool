import type { Panel, StateChange } from '../ui/panel';
import type { Splitter } from './splitter';

export class LayoutManager {
  private panels = new Map<string, Panel>();
  private rootContainer: HTMLElement;
  private mainElement: HTMLElement;

  constructor(rootContainer: HTMLElement) {
    this.rootContainer = rootContainer;
    this.rootContainer.innerHTML = '';
    this.rootContainer.classList.add('app-layout');

    // Header
    const header = document.createElement('header');
    header.className = 'app-header';
    header.id = 'app-header';
    this.rootContainer.appendChild(header);

    // Main content area
    this.mainElement = document.createElement('main');
    this.mainElement.className = 'app-main';
    this.rootContainer.appendChild(this.mainElement);

    // Footer
    const footer = document.createElement('footer');
    footer.className = 'app-footer';
    footer.id = 'app-footer';
    this.rootContainer.appendChild(footer);
  }

  set body(splitter: Splitter) {
    this.mainElement.innerHTML = '';
    this.mainElement.appendChild(splitter.element);

    this.panels.clear();
    for (const panel of splitter.collectPanels()) {
      this.panels.set(panel.id, panel);
    }
  }

  getPanel(id: string): Panel | null {
    return this.panels.get(id) ?? null;
  }

  getHeader(): HTMLElement {
    return this.rootContainer.querySelector('#app-header')!;
  }

  getFooter(): HTMLElement {
    return this.rootContainer.querySelector('#app-footer')!;
  }

  broadcastStateChange(change: StateChange): void {
    for (const panel of this.panels.values()) {
      panel.onStateChange?.(change);
    }
  }
}
