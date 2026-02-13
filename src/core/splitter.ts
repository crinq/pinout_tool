import type { Panel } from '../ui/panel';

export type SplitChild = Panel | Splitter;

export interface Splitter {
  readonly element: HTMLElement;
  add(child: SplitChild, weight: number): void;
  collectPanels(): Panel[];
}

function isPanel(child: SplitChild): child is Panel {
  return 'createView' in child;
}

const MIN_PANE_SIZE = 50;

class SplitterImpl implements Splitter {
  readonly element: HTMLElement;
  private children: SplitChild[] = [];
  private panes: HTMLElement[] = [];
  private direction: 'horizontal' | 'vertical';

  constructor(direction: 'horizontal' | 'vertical') {
    this.direction = direction;
    this.element = document.createElement('div');
    this.element.className = direction === 'horizontal' ? 'splitter-h' : 'splitter-v';
  }

  add(child: SplitChild, weight: number): void {
    // Insert handle before pane (if not the first child)
    if (this.children.length > 0) {
      const handle = document.createElement('div');
      handle.className = this.direction === 'horizontal'
        ? 'splitter-handle splitter-handle-h'
        : 'splitter-handle splitter-handle-v';
      this.element.appendChild(handle);

      const prevPane = this.panes[this.panes.length - 1];
      this.setupDragHandle(handle, prevPane);
    }

    const pane = document.createElement('div');
    pane.className = 'splitter-pane';
    pane.style.flex = String(weight);

    if (isPanel(child)) {
      const panelWrapper = document.createElement('div');
      panelWrapper.className = 'panel-wrapper';
      panelWrapper.dataset.panelId = child.id;

      const panelHeader = document.createElement('div');
      panelHeader.className = 'panel-header';
      panelHeader.textContent = child.title;

      const panelContent = document.createElement('div');
      panelContent.className = 'panel-content';

      panelWrapper.appendChild(panelHeader);
      panelWrapper.appendChild(panelContent);
      pane.appendChild(panelWrapper);

      child.createView(panelContent);
    } else {
      pane.appendChild(child.element);
    }

    this.element.appendChild(pane);
    this.children.push(child);
    this.panes.push(pane);
  }

  collectPanels(): Panel[] {
    const panels: Panel[] = [];
    for (const child of this.children) {
      if (isPanel(child)) {
        panels.push(child);
      } else {
        panels.push(...child.collectPanels());
      }
    }
    return panels;
  }

  private setupDragHandle(handle: HTMLElement, prevPane: HTMLElement): void {
    const isHorizontal = this.direction === 'horizontal';

    handle.addEventListener('mousedown', (e: MouseEvent) => {
      e.preventDefault();

      // The next pane is the sibling after the handle
      const nextPane = handle.nextElementSibling as HTMLElement;
      if (!nextPane) return;

      const startPos = isHorizontal ? e.clientX : e.clientY;
      const prevRect = prevPane.getBoundingClientRect();
      const nextRect = nextPane.getBoundingClientRect();
      const prevStartSize = isHorizontal ? prevRect.width : prevRect.height;
      const nextStartSize = isHorizontal ? nextRect.width : nextRect.height;

      const cursorStyle = isHorizontal ? 'col-resize' : 'row-resize';
      document.body.classList.add('splitter-dragging');
      document.body.style.cursor = cursorStyle;

      const onMouseMove = (moveEvent: MouseEvent) => {
        const currentPos = isHorizontal ? moveEvent.clientX : moveEvent.clientY;
        let delta = currentPos - startPos;

        // Clamp to min sizes
        let newPrevSize = prevStartSize + delta;
        let newNextSize = nextStartSize - delta;

        if (newPrevSize < MIN_PANE_SIZE) {
          delta = MIN_PANE_SIZE - prevStartSize;
          newPrevSize = MIN_PANE_SIZE;
          newNextSize = nextStartSize - delta;
        }
        if (newNextSize < MIN_PANE_SIZE) {
          delta = nextStartSize - MIN_PANE_SIZE;
          newNextSize = MIN_PANE_SIZE;
          newPrevSize = prevStartSize + delta;
        }

        prevPane.style.flex = `0 0 ${newPrevSize}px`;
        nextPane.style.flex = `0 0 ${newNextSize}px`;
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.body.classList.remove('splitter-dragging');
        document.body.style.cursor = '';
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }
}

export function HorizontalSplitter(): Splitter {
  return new SplitterImpl('horizontal');
}

export function VerticalSplitter(): Splitter {
  return new SplitterImpl('vertical');
}
