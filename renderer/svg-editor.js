/**
 * SVG 编辑器模块 - 增强版
 */

class SVGEditor {
  constructor(container) {
    this.container = container;
    this.svgElement = null;
    this.selectedElement = null;
    this.isDragging = false;
    this.dragOffset = { x: 0, y: 0 };
    this.elements = [];
    this.isInitialized = false;
    this.onExportCallback = null;
    this.currentTool = 'select';
    this.editInput = null;
    this.editElement = null;
  }

  init() {
    if (this.isInitialized) return;

    this.createToolbar();
    this.createSVGCanvas();
    
    this.isInitialized = true;
  }

  createToolbar() {
    const toolbar = document.createElement('div');
    toolbar.style.cssText = `
      position: absolute;
      top: 10px;
      left: 10px;
      background: white;
      border: 1px solid #d0d7de;
      border-radius: 8px;
      padding: 8px;
      display: flex;
      gap: 4px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
      z-index: 1000;
    `;

    toolbar.innerHTML = `
      <button type="button" id="svg-tool-select" title="选择工具" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: #0969da; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">☝️</button>
      <button type="button" id="svg-tool-rect" title="添加矩形" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">▢</button>
      <button type="button" id="svg-tool-ellipse" title="添加椭圆" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">⬭</button>
      <button type="button" id="svg-tool-diamond" title="添加菱形" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">◇</button>
      <div style="width: 1px; height: 28px; background: #d0d7de; margin: 4px 4px;"></div>
      <button type="button" id="svg-tool-delete" title="删除选中" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">🗑️</button>
      <div style="width: 1px; height: 28px; background: #d0d7de; margin: 4px 4px;"></div>
      <button type="button" id="svg-tool-export-svg" title="导出 SVG" style="width: auto; padding: 0 12px; height: 36px; border: none; border-radius: 6px; background: #2da44e; color: white; cursor: pointer; font-size: 12px;">SVG</button>
      <button type="button" id="svg-tool-export-png" title="导出 PNG" style="width: auto; padding: 0 12px; height: 36px; border: none; border-radius: 6px; background: #2da44e; color: white; cursor: pointer; font-size: 12px;">PNG</button>
    `;

    this.container.appendChild(toolbar);
    this.toolbar = toolbar;
    this.bindToolbarEvents();
  }

  createSVGCanvas() {
    // 只清除之前创建的 SVG 画布，保留工具栏
    const existingCanvas = document.getElementById('editor-svg-canvas');
    if (existingCanvas) {
      existingCanvas.remove();
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.style.cssText = 'background: white; cursor: crosshair; position: absolute; top: 0; left: 0;';
    svg.id = 'editor-svg-canvas';

    this.container.appendChild(svg);
    this.svgElement = svg;
    this.bindCanvasEvents();
  }

  bindToolbarEvents() {
    const buttons = this.toolbar.querySelectorAll('button');
    
    document.getElementById('svg-tool-select').addEventListener('click', () => {
      this.currentTool = 'select';
      this.updateButtonStyles('svg-tool-select');
    });

    document.getElementById('svg-tool-rect').addEventListener('click', () => {
      this.currentTool = 'rect';
      this.updateButtonStyles('svg-tool-rect');
    });

    document.getElementById('svg-tool-ellipse').addEventListener('click', () => {
      this.currentTool = 'ellipse';
      this.updateButtonStyles('svg-tool-ellipse');
    });

    document.getElementById('svg-tool-diamond').addEventListener('click', () => {
      this.currentTool = 'diamond';
      this.updateButtonStyles('svg-tool-diamond');
    });

    document.getElementById('svg-tool-delete').addEventListener('click', () => this.deleteSelected());
    document.getElementById('svg-tool-export-svg').addEventListener('click', () => this.exportAsSVG());
    document.getElementById('svg-tool-export-png').addEventListener('click', () => this.exportAsPNG());
  }

  updateButtonStyles(activeId) {
    this.toolbar.querySelectorAll('button').forEach(btn => {
      if (btn.classList.contains('active')) {
        btn.classList.remove('active');
        btn.style.background = 'white';
        btn.style.color = '#59636e';
      }
    });
    const activeBtn = document.getElementById(activeId);
    if (activeBtn) {
      activeBtn.classList.add('active');
      activeBtn.style.background = '#0969da';
      activeBtn.style.color = 'white';
    }
  }

  bindCanvasEvents() {
    this.svgElement.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    document.addEventListener('mouseup', () => this.handleMouseUp());
    this.svgElement.addEventListener('dblclick', (e) => this.handleDoubleClick(e));

    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !this.editInput) {
        this.deleteSelected();
      }
      if (e.key === 'Escape') {
        this.cancelEdit();
      }
    });
  }

  handleMouseDown(e) {
    if (this.editInput) {
      this.finishEdit();
      return;
    }

    const target = e.target;
    
    // 查找数据元素
    let dataElement = this.findDataElement(target);
    
    if (dataElement) {
      if (this.currentTool === 'select') {
        this.selectElement(dataElement);
        this.startDrag(e, dataElement);
      }
    } else {
      this.deselectAll();

      if (this.currentTool !== 'select') {
        const rect = this.svgElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        this.createElementAt(x, y, this.currentTool);
      }
    }
  }

  findDataElement(target) {
    let element = target;
    while (element && element !== this.svgElement) {
      if (element.hasAttribute && element.hasAttribute('data-element-id')) {
        return element;
      }
      element = element.parentElement;
    }
    return null;
  }

  startDrag(e, element) {
    this.isDragging = true;
    this.dragOffset = {
      x: e.clientX,
      y: e.clientY
    };
  }

  handleMouseMove(e) {
    if (this.isDragging && this.selectedElement) {
      const dx = e.clientX - this.dragOffset.x;
      const dy = e.clientY - this.dragOffset.y;
      this.moveElement(this.selectedElement, dx, dy);
      this.dragOffset = { x: e.clientX, y: e.clientY };
    }
  }

  handleMouseUp() {
    this.isDragging = false;
  }

  handleDoubleClick(e) {
    const target = e.target;
    let dataElement = this.findDataElement(target);
    
    if (dataElement && this.currentTool === 'select') {
      this.editText(dataElement);
    }
  }

  createElementAt(x, y, type) {
    let element;
    const id = 'element-' + Date.now();

    switch (type) {
      case 'rect':
        element = this.createRect(x, y, id);
        break;
      case 'ellipse':
        element = this.createEllipse(x, y, id);
        break;
      case 'diamond':
        element = this.createDiamond(x, y, id);
        break;
      default:
        return;
    }

    this.elements.push(element);
    this.svgElement.appendChild(element);
    this.selectElement(element);
  }

  createRect(x, y, id) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-element-id', id);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', 0);
    rect.setAttribute('width', 100);
    rect.setAttribute('height', 60);
    rect.setAttribute('fill', 'white');
    rect.setAttribute('stroke', 'black');
    rect.setAttribute('stroke-width', '2');
    rect.setAttribute('rx', '8');

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', 50);
    text.setAttribute('y', 35);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '14');
    text.textContent = '处理';

    g.appendChild(rect);
    g.appendChild(text);
    g.setAttribute('transform', `translate(${x - 50}, ${y - 30})`);
    g.style.cursor = 'move';

    return g;
  }

  createEllipse(x, y, id) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-element-id', id);

    const ellipse = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
    ellipse.setAttribute('cx', 50);
    ellipse.setAttribute('cy', 25);
    ellipse.setAttribute('rx', 50);
    ellipse.setAttribute('ry', 25);
    ellipse.setAttribute('fill', 'white');
    ellipse.setAttribute('stroke', 'black');
    ellipse.setAttribute('stroke-width', '2');

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', 50);
    text.setAttribute('y', 30);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '12');
    text.textContent = '开始/结束';

    g.appendChild(ellipse);
    g.appendChild(text);
    g.setAttribute('transform', `translate(${x - 50}, ${y - 25})`);
    g.style.cursor = 'move';

    return g;
  }

  createDiamond(x, y, id) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-element-id', id);

    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', '50,0 100,40 50,80 0,40');
    polygon.setAttribute('fill', 'white');
    polygon.setAttribute('stroke', 'black');
    polygon.setAttribute('stroke-width', '2');

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', 50);
    text.setAttribute('y', 45);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '12');
    text.textContent = '判断';

    g.appendChild(polygon);
    g.appendChild(text);
    g.setAttribute('transform', `translate(${x - 50}, ${y - 40})`);
    g.style.cursor = 'move';

    return g;
  }

  selectElement(element) {
    this.deselectAll();
    this.selectedElement = element;
    element.style.filter = 'drop-shadow(0 0 3px #0969da)';
  }

  deselectAll() {
    if (this.selectedElement) {
      this.selectedElement.style.filter = '';
      this.selectedElement = null;
    }
  }

  moveElement(element, dx, dy) {
    const transform = element.getAttribute('transform');
    let tx = 0, ty = 0;

    if (transform && transform.startsWith('translate(')) {
      const match = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
      if (match) {
        tx = parseFloat(match[1]) || 0;
        ty = parseFloat(match[2]) || 0;
      }
    }

    tx += dx;
    ty += dy;
    element.setAttribute('transform', `translate(${tx}, ${ty})`);
  }

  deleteSelected() {
    if (this.selectedElement) {
      const id = this.selectedElement.getAttribute('data-element-id');
      this.elements = this.elements.filter(el => el.getAttribute('data-element-id') !== id);
      this.selectedElement.remove();
      this.selectedElement = null;
    }
  }

  editText(element) {
    const textEl = element.querySelector('text');
    if (!textEl) return;

    const rect = textEl.getBoundingClientRect();
    const svgRect = this.svgElement.getBoundingClientRect();

    this.editInput = document.createElement('input');
    this.editInput.type = 'text';
    this.editInput.value = textEl.textContent;
    this.editInput.style.position = 'absolute';
    this.editInput.style.left = (rect.left - svgRect.left) + 'px';
    this.editInput.style.top = (rect.top - svgRect.top) + 'px';
    this.editInput.style.width = (rect.width + 20) + 'px';
    this.editInput.style.fontSize = textEl.getAttribute('font-size') || '14px';
    this.editInput.style.border = '1px solid #0969da';
    this.editInput.style.borderRadius = '4px';
    this.editInput.style.padding = '2px 6px';
    this.editInput.style.background = 'white';
    this.editInput.style.zIndex = '2000';
    this.editInput.style.outline = 'none';

    this.editInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        this.finishEdit();
      } else if (e.key === 'Escape') {
        this.cancelEdit();
      }
    });

    this.editInput.addEventListener('blur', () => {
      this.finishEdit();
    });

    this.container.appendChild(this.editInput);
    this.editInput.select();
    this.editElement = textEl;
  }

  finishEdit() {
    if (this.editInput && this.editElement) {
      this.editElement.textContent = this.editInput.value;
    }
    this.cancelEdit();
  }

  cancelEdit() {
    if (this.editInput) {
      this.editInput.remove();
      this.editInput = null;
      this.editElement = null;
    }
  }

  importPlantUMLSVG(svgElement) {
    if (!svgElement) return;

    while (this.svgElement.firstChild) {
      this.svgElement.removeChild(this.svgElement.firstChild);
    }

    const clone = svgElement.cloneNode(true);
    this.makeElementsInteractive(clone);

    Array.from(clone.childNodes).forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) {
        this.svgElement.appendChild(node.cloneNode(true));
      }
    });
  }

  makeElementsInteractive(svg) {
    const groups = svg.querySelectorAll('g');
    let elementId = 0;

    groups.forEach((group) => {
      const hasShape = group.querySelector('rect, ellipse, polygon, circle, path');
      if (hasShape && !group.hasAttribute('data-element-id')) {
        group.setAttribute('data-element-id', 'plantuml-' + elementId++);
        group.style.cursor = 'move';
        
        hasShape.setAttribute('fill', 'white');
        hasShape.setAttribute('stroke', 'black');
        hasShape.setAttribute('stroke-width', '2');
      }
    });

    const shapes = svg.querySelectorAll('rect, ellipse, polygon, circle');
    shapes.forEach((shape) => {
      let parentGroup = shape.parentElement;
      while (parentGroup && parentGroup.tagName !== 'g' && parentGroup.tagName !== 'svg') {
        parentGroup = parentGroup.parentElement;
      }
      
      if (parentGroup && parentGroup.tagName === 'g' && !parentGroup.hasAttribute('data-element-id')) {
        parentGroup.setAttribute('data-element-id', 'plantuml-' + elementId++);
        parentGroup.style.cursor = 'move';
        
        shape.setAttribute('fill', 'white');
        shape.setAttribute('stroke', 'black');
        shape.setAttribute('stroke-width', '2');
      }
    });

    const texts = svg.querySelectorAll('text');
    texts.forEach(text => {
      text.setAttribute('fill', 'black');
    });
  }

  exportAsSVG() {
    const serializer = new XMLSerializer();
    const svgData = serializer.serializeToString(this.svgElement);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml' });

    if (this.onExportCallback) {
      this.onExportCallback({
        kind: 'svg',
        svgText: svgData,
        blob: svgBlob
      });
    }

    return svgBlob;
  }

  exportAsPNG() {
    return new Promise((resolve) => {
      const serializer = new XMLSerializer();
      const svgData = serializer.serializeToString(this.svgElement);
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width * 2;
        canvas.height = img.height * 2;
        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2);
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, img.width, img.height);
        ctx.drawImage(img, 0, 0);

        canvas.toBlob((pngBlob) => {
          URL.revokeObjectURL(url);

          if (this.onExportCallback) {
            this.onExportCallback({
              kind: 'png',
              blob: pngBlob
            });
          }

          resolve(pngBlob);
        }, 'image/png');
      };

      img.src = url;
    });
  }

  destroy() {
    if (this.toolbar) {
      this.toolbar.remove();
    }
    if (this.svgElement) {
      this.svgElement.remove();
    }
    this.cancelEdit();
    this.isInitialized = false;
  }
}

function createSVGEditor(container) {
  const editor = new SVGEditor(container);
  editor.init();
  return editor;
}

export { SVGEditor, createSVGEditor };