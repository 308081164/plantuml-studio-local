/**
 * 交互式画板编辑器模块
 * PlantUML SVG 元素可拖拽编辑功能
 */

class CanvasEditor {
  constructor(container) {
    this.container = container;
    this.svgElement = null;
    this.editableElements = [];
    this.connections = [];
    this.selectedElement = null;
    this.isDragging = false;
    this.isConnecting = false;
    this.dragOffset = { x: 0, y: 0 };
    this.tempConnection = null;
    this.connectionAnchors = [];
    this.undoStack = [];
    this.redoStack = [];
    this.tool = 'select';
    this.onExportCallback = null;
  }

  /**
   * 初始化编辑器
   * @param {SVGElement} svgElement - PlantUML 渲染的 SVG 元素
   */
  init(svgElement) {
    this.svgElement = svgElement;
    this.editableElements = [];
    this.connections = [];
    this.selectedElement = null;
    this.undoStack = [];
    this.redoStack = [];

    this.resizeSVGToContainer();
    this.parseSVG();
    this.setupEventListeners();
    this.addToolbar();
    this.addGridBackground();
  }

  resizeSVGToContainer() {
    if (!this.svgElement || !this.container) return;
    
    const containerRect = this.container.getBoundingClientRect();
    
    this.svgElement.setAttribute('width', containerRect.width);
    this.svgElement.setAttribute('height', containerRect.height);
    this.svgElement.style.width = '100%';
    this.svgElement.style.height = '100%';
    this.svgElement.style.maxWidth = 'none';
    this.svgElement.style.maxHeight = 'none';
  }

  /**
   * 解析 SVG，提取可编辑元素
   */
  parseSVG() {
    if (!this.svgElement) return;

    const elements = this.svgElement.querySelectorAll('g, rect, ellipse, polygon, path');
    
    const processedGroups = new Set();

    elements.forEach((el, index) => {
      let group = el;
      
      if (el.tagName !== 'g') {
        group = el.closest('g');
      }

      if (!group || processedGroups.has(group)) return;
      processedGroups.add(group);

      const bbox = group.getBoundingClientRect();
      if (bbox.width > 10 && bbox.height > 10) {
        const element = {
          id: `editable-${index}`,
          group: group,
          type: this.detectElementType(group),
          originalX: 0,
          originalY: 0,
          label: this.extractLabel(group)
        };
        this.editableElements.push(element);
        group.setAttribute('data-editable', element.id);
        group.style.cursor = 'move';
        
        group.style.pointerEvents = 'bounding-box';
      }
    });

    this.findConnections();
    this.addAnchorsToElements();
  }

  /**
   * 检测元素类型
   */
  detectElementType(group) {
    const rect = group.querySelector('rect');
    const ellipse = group.querySelector('ellipse');
    const path = group.querySelector('path');
    const polygon = group.querySelector('polygon');

    if (rect && !path && !polygon) return 'rectangle';
    if (ellipse) return 'ellipse';
    if (path) return 'shape';
    if (polygon) return 'diamond';
    return 'unknown';
  }

  /**
   * 提取元素标签
   */
  extractLabel(group) {
    const text = group.querySelector('text');
    if (text) return text.textContent;

    const tspan = group.querySelector('tspan');
    if (tspan) return tspan.textContent;

    return '';
  }

  /**
   * 查找连接线
   */
  findConnections() {
    const paths = this.svgElement.querySelectorAll('path');
    paths.forEach((path, index) => {
      if (!path.closest('[data-editable]')) {
        const connection = {
          id: `connection-${index}`,
          path: path,
          points: this.extractPathPoints(path)
        };
        this.connections.push(connection);
      }
    });
  }

  /**
   * 提取路径点
   */
  extractPathPoints(path) {
    const d = path.getAttribute('d');
    const points = [];
    const commands = d.match(/[MLQCZ][^MLQCZ]*/gi) || [];

    commands.forEach(cmd => {
      const type = cmd[0].toUpperCase();
      const coords = cmd.slice(1).trim().split(/[\s,]+/).map(Number);
      if (type === 'M' || type === 'L') {
        points.push({ x: coords[0], y: coords[1] });
      } else if (type === 'Q' || type === 'C') {
        points.push({ x: coords[coords.length - 2], y: coords[coords.length - 1] });
      }
    });

    return points;
  }

  /**
   * 为元素添加锚点
   */
  addAnchorsToElements() {
    this.editableElements.forEach(element => {
      const bbox = element.group.getBoundingClientRect();
      const svgRect = this.svgElement.getBoundingClientRect();

      const anchors = [
        { position: 'top', x: bbox.left + bbox.width / 2 - svgRect.left, y: bbox.top - svgRect.top },
        { position: 'bottom', x: bbox.left + bbox.width / 2 - svgRect.left, y: bbox.bottom - svgRect.top },
        { position: 'left', x: bbox.left - svgRect.left, y: bbox.top + bbox.height / 2 - svgRect.top },
        { position: 'right', x: bbox.right - svgRect.left, y: bbox.top + bbox.height / 2 - svgRect.top }
      ];

      anchors.forEach((anchor, index) => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', anchor.x);
        circle.setAttribute('cy', anchor.y);
        circle.setAttribute('r', 5);
        circle.setAttribute('fill', '#0969da');
        circle.setAttribute('stroke', '#fff');
        circle.setAttribute('stroke-width', 2);
        circle.setAttribute('class', 'anchor-point');
        circle.setAttribute('data-element-id', element.id);
        circle.setAttribute('data-anchor-position', anchor.position);
        circle.style.display = 'none';
        circle.style.cursor = 'crosshair';
        this.svgElement.appendChild(circle);
        element.anchors = anchors;
      });
    });
  }

  /**
   * 设置事件监听
   */
  setupEventListeners() {
    this.svgElement.addEventListener('mousedown', this.onMouseDown.bind(this));
    document.addEventListener('mousemove', this.onMouseMove.bind(this));
    document.addEventListener('mouseup', this.onMouseUp.bind(this));
    this.svgElement.addEventListener('dblclick', this.onDoubleClick.bind(this));

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (this.selectedElement) {
          this.deleteElement(this.selectedElement);
        }
      }
      if (e.ctrlKey && e.key === 'z') {
        this.undo();
      }
      if (e.ctrlKey && e.key === 'y') {
        this.redo();
      }
    });
  }

  /**
   * 鼠标按下事件
   */
  onMouseDown(e) {
    const target = e.target;

    if (target.classList.contains('anchor-point')) {
      this.isConnecting = true;
      this.connectionStart = {
        elementId: target.getAttribute('data-element-id'),
        position: target.getAttribute('data-anchor-position'),
        x: parseFloat(target.getAttribute('cx')),
        y: parseFloat(target.getAttribute('cy'))
      };
      this.startTempConnection(this.connectionStart.x, this.connectionStart.y);
      e.preventDefault();
      return;
    }

    let editableGroup = target.closest('[data-editable]');
    
    if (!editableGroup) {
      const svgRect = this.svgElement.getBoundingClientRect();
      const x = e.clientX - svgRect.left;
      const y = e.clientY - svgRect.top;
      
      editableGroup = this.findGroupAtPosition(x, y);
    }

    if (editableGroup) {
      this.selectElement(editableGroup);
      this.isDragging = true;

      const bbox = editableGroup.getBoundingClientRect();
      this.dragOffset = {
        x: e.clientX - bbox.left,
        y: e.clientY - bbox.top
      };

      this.saveState();
      e.preventDefault();
    } else {
      this.deselectAll();
    }
  }

  findGroupAtPosition(x, y) {
    for (const element of this.editableElements) {
      const bbox = element.group.getBoundingClientRect();
      const svgRect = this.svgElement.getBoundingClientRect();
      
      const elemX = bbox.left - svgRect.left;
      const elemY = bbox.top - svgRect.top;
      
      if (x >= elemX && x <= elemX + bbox.width &&
          y >= elemY && y <= elemY + bbox.height) {
        return element.group;
      }
    }
    return null;
  }

  /**
   * 鼠标移动事件
   */
  onMouseMove(e) {
    if (this.isDragging && this.selectedElement) {
      const svgRect = this.svgElement.getBoundingClientRect();
      const x = e.clientX - svgRect.left - this.dragOffset.x;
      const y = e.clientY - svgRect.top - this.dragOffset.y;

      this.moveElement(this.selectedElement, x, y);
    }

    if (this.isConnecting && this.tempConnection) {
      const svgRect = this.svgElement.getBoundingClientRect();
      const x = e.clientX - svgRect.left;
      const y = e.clientY - svgRect.top;
      this.updateTempConnection(x, y);
    }
  }

  /**
   * 鼠标释放事件
   */
  onMouseUp(e) {
    if (this.isDragging) {
      this.isDragging = false;
    }

    if (this.isConnecting) {
      this.isConnecting = false;
      this.finishConnection(e);
    }
  }

  /**
   * 双击事件 - 编辑元素文本
   */
  onDoubleClick(e) {
    const editableGroup = e.target.closest('[data-editable]');
    if (editableGroup) {
      this.editElementText(editableGroup);
    }
  }

  /**
   * 选择元素
   */
  selectElement(group) {
    this.deselectAll();
    this.selectedElement = group;
    group.setAttribute('stroke', '#0969da');
    group.setAttribute('stroke-width', '2');

    group.querySelectorAll('.anchor-point').forEach(anchor => {
      anchor.style.display = 'block';
    });
  }

  /**
   * 取消选择所有元素
   */
  deselectAll() {
    if (this.selectedElement) {
      this.selectedElement.setAttribute('stroke', '');
      this.selectedElement.setAttribute('stroke-width', '');
      this.selectedElement.querySelectorAll('.anchor-point').forEach(anchor => {
        anchor.style.display = 'none';
      });
      this.selectedElement = null;
    }
  }

  /**
   * 移动元素
   */
  moveElement(group, x, y) {
    const transform = group.getAttribute('transform') || '';
    const translateMatch = transform.match(/translate\(([^)]+)\)/);

    let currentX = 0, currentY = 0;
    if (translateMatch) {
      const [tx, ty] = translateMatch[1].split(/[\s,]+/).map(Number);
      currentX = tx || 0;
      currentY = ty || 0;
    }

    const deltaX = x - currentX;
    const deltaY = y - currentY;

    const newTransform = `translate(${x}, ${y})`;
    group.setAttribute('transform', newTransform);

    this.updateConnectionsForElement(group);
    this.updateAnchorPositions(group);
  }

  /**
   * 更新锚点位置
   */
  updateAnchorPositions(group) {
    const element = this.editableElements.find(el => el.group === group);
    if (!element || !element.anchors) return;

    const bbox = group.getBoundingClientRect();
    const svgRect = this.svgElement.getBoundingClientRect();

    const positions = ['top', 'bottom', 'left', 'right'];
    const anchors = group.querySelectorAll('.anchor-point');

    anchors.forEach((anchor, index) => {
      const position = positions[index];
      let x, y;

      switch (position) {
        case 'top':
          x = bbox.left + bbox.width / 2 - svgRect.left;
          y = bbox.top - svgRect.top;
          break;
        case 'bottom':
          x = bbox.left + bbox.width / 2 - svgRect.left;
          y = bbox.bottom - svgRect.top;
          break;
        case 'left':
          x = bbox.left - svgRect.left;
          y = bbox.top + bbox.height / 2 - svgRect.top;
          break;
        case 'right':
          x = bbox.right - svgRect.left;
          y = bbox.top + bbox.height / 2 - svgRect.top;
          break;
      }

      anchor.setAttribute('cx', x);
      anchor.setAttribute('cy', y);
    });
  }

  /**
   * 更新连接线
   */
  updateConnectionsForElement(group) {
    const groupId = group.getAttribute('data-editable');

    this.connections.forEach(conn => {
      const pathPoints = this.extractPathPoints(conn.path);
      if (pathPoints.length >= 2) {
        const start = pathPoints[0];
        const end = pathPoints[pathPoints.length - 1];

        const elements = this.editableElements;
        for (const el of elements) {
          if (!el.anchors) continue;
          const bbox = el.group.getBoundingClientRect();
          const svgRect = this.svgElement.getBoundingClientRect();

          for (const anchor of el.anchors) {
            const anchorX = bbox.left + (anchor.position === 'left' ? 0 : anchor.position === 'right' ? bbox.width : bbox.width / 2) - svgRect.left;
            const anchorY = bbox.top + (anchor.position === 'top' ? 0 : anchor.position === 'bottom' ? bbox.height : bbox.height / 2) - svgRect.top;

            if (Math.abs(start.x - anchorX) < 20 && Math.abs(start.y - anchorY) < 20) {
              const newD = conn.path.getAttribute('d').replace(/^M[^L]*/, `M ${anchorX} ${anchorY}`);
              conn.path.setAttribute('d', newD);
            }
            if (Math.abs(end.x - anchorX) < 20 && Math.abs(end.y - anchorY) < 20) {
              const parts = conn.path.getAttribute('d').split(/(?=[MLQCZ])/i);
              const lastPart = parts[parts.length - 1];
              const newLastPart = lastPart.replace(/^[LM]\s*[\d.,\s-]+/, `L ${anchorX} ${anchorY}`);
              conn.path.setAttribute('d', parts.slice(0, -1).join('') + newLastPart);
            }
          }
        }
      }
    });
  }

  /**
   * 开始临时连接线
   */
  startTempConnection(x, y) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', x);
    line.setAttribute('y1', y);
    line.setAttribute('x2', x);
    line.setAttribute('y2', y);
    line.setAttribute('stroke', '#0969da');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-dasharray', '5,5');
    line.setAttribute('class', 'temp-connection');
    this.svgElement.appendChild(line);
    this.tempConnection = line;
  }

  /**
   * 更新临时连接线
   */
  updateTempConnection(x, y) {
    if (this.tempConnection) {
      this.tempConnection.setAttribute('x2', x);
      this.tempConnection.setAttribute('y2', y);
    }
  }

  /**
   * 完成连接
   */
  finishConnection(e) {
    if (!this.tempConnection) return;

    const target = e.target;
    if (target.classList.contains('anchor-point')) {
      const endElementId = target.getAttribute('data-element-id');
      const endPosition = target.getAttribute('data-anchor-position');
      const endX = parseFloat(target.getAttribute('cx'));
      const endY = parseFloat(target.getAttribute('cy'));

      if (this.connectionStart.elementId !== endElementId) {
        this.createConnection(
          this.connectionStart.elementId,
          this.connectionStart.position,
          endElementId,
          endPosition
        );
      }
    }

    this.tempConnection.remove();
    this.tempConnection = null;
  }

  /**
   * 创建连接线
   */
  createConnection(startElementId, startPosition, endElementId, endPosition) {
    const startElement = this.editableElements.find(el => el.id === startElementId);
    const endElement = this.editableElements.find(el => el.id === endElementId);

    if (!startElement || !endElement) return;

    const startBbox = startElement.group.getBoundingClientRect();
    const endBbox = endElement.group.getBoundingClientRect();
    const svgRect = this.svgElement.getBoundingClientRect();

    const getAnchorPoint = (bbox, position) => {
      switch (position) {
        case 'top':
          return { x: bbox.left + bbox.width / 2 - svgRect.left, y: bbox.top - svgRect.top };
        case 'bottom':
          return { x: bbox.left + bbox.width / 2 - svgRect.left, y: bbox.bottom - svgRect.top };
        case 'left':
          return { x: bbox.left - svgRect.left, y: bbox.top + bbox.height / 2 - svgRect.top };
        case 'right':
          return { x: bbox.right - svgRect.left, y: bbox.top + bbox.height / 2 - svgRect.top };
        default:
          return { x: bbox.left + bbox.width / 2 - svgRect.left, y: bbox.top + bbox.height / 2 - svgRect.top };
      }
    };

    const start = getAnchorPoint(startBbox, startPosition);
    const end = getAnchorPoint(endBbox, endPosition);

    const midX = (start.x + end.x) / 2;

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = `M ${start.x} ${start.y} C ${midX} ${start.y}, ${midX} ${end.y}, ${end.x} ${end.y}`;
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#333');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('marker-end', 'url(#arrow)');

    this.svgElement.appendChild(path);
    this.addArrowMarker();

    const connection = {
      id: `connection-${Date.now()}`,
      path: path,
      startElement: startElementId,
      endElement: endElementId
    };
    this.connections.push(connection);
    this.saveState();
  }

  /**
   * 添加箭头标记
   */
  addArrowMarker() {
    if (this.svgElement.querySelector('#arrow')) return;

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
    marker.setAttribute('id', 'arrow');
    marker.setAttribute('viewBox', '0 0 10 10');
    marker.setAttribute('refX', '9');
    marker.setAttribute('refY', '5');
    marker.setAttribute('markerWidth', '6');
    marker.setAttribute('markerHeight', '6');
    marker.setAttribute('orient', 'auto-start-reverse');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
    path.setAttribute('fill', '#333');

    marker.appendChild(path);
    defs.appendChild(marker);
    this.svgElement.insertBefore(defs, this.svgElement.firstChild);
  }

  /**
   * 添加元素
   */
  addElement(type, x, y) {
    const svgRect = this.svgElement.getBoundingClientRect();
    const absX = x - svgRect.left;
    const absY = y - svgRect.top;

    let newElement;
    const id = `new-element-${Date.now()}`;

    switch (type) {
      case 'rectangle':
        newElement = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        newElement.setAttribute('x', absX);
        newElement.setAttribute('y', absY);
        newElement.setAttribute('width', '100');
        newElement.setAttribute('height', '50');
        newElement.setAttribute('fill', 'white');
        newElement.setAttribute('stroke', 'black');
        newElement.setAttribute('stroke-width', '2');
        break;

      case 'ellipse':
        newElement = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
        newElement.setAttribute('cx', absX + 50);
        newElement.setAttribute('cy', absY + 25);
        newElement.setAttribute('rx', '50');
        newElement.setAttribute('ry', '25');
        newElement.setAttribute('fill', 'white');
        newElement.setAttribute('stroke', 'black');
        newElement.setAttribute('stroke-width', '2');
        break;

      case 'diamond':
        const points = `${absX + 50},${absY} ${absX + 100},${absY + 25} ${absX + 50},${absY + 50} ${absX},${absY + 25}`;
        newElement = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        newElement.setAttribute('points', points);
        newElement.setAttribute('fill', 'white');
        newElement.setAttribute('stroke', 'black');
        newElement.setAttribute('stroke-width', '2');
        break;

      default:
        return;
    }

    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    group.appendChild(newElement);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('x', absX + 50);
    text.setAttribute('y', absY + 30);
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('font-size', '14');
    text.textContent = '新元素';
    group.appendChild(text);

    group.setAttribute('data-editable', id);
    group.style.cursor = 'move';
    this.svgElement.appendChild(group);

    const element = {
      id: id,
      group: group,
      type: type,
      originalX: absX,
      originalY: absY,
      label: '新元素'
    };
    this.editableElements.push(element);

    this.addAnchorsForSingleElement(element);
    this.saveState();
    this.selectElement(group);
  }

  /**
   * 为单个元素添加锚点
   */
  addAnchorsForSingleElement(element) {
    const bbox = element.group.getBoundingClientRect();
    const svgRect = this.svgElement.getBoundingClientRect();

    const positions = ['top', 'bottom', 'left', 'right'];

    positions.forEach((position, index) => {
      let x, y;
      switch (position) {
        case 'top':
          x = bbox.left + bbox.width / 2 - svgRect.left;
          y = bbox.top - svgRect.top;
          break;
        case 'bottom':
          x = bbox.left + bbox.width / 2 - svgRect.left;
          y = bbox.bottom - svgRect.top;
          break;
        case 'left':
          x = bbox.left - svgRect.left;
          y = bbox.top + bbox.height / 2 - svgRect.top;
          break;
        case 'right':
          x = bbox.right - svgRect.left;
          y = bbox.top + bbox.height / 2 - svgRect.top;
          break;
      }

      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
      circle.setAttribute('r', 5);
      circle.setAttribute('fill', '#0969da');
      circle.setAttribute('stroke', '#fff');
      circle.setAttribute('stroke-width', 2);
      circle.setAttribute('class', 'anchor-point');
      circle.setAttribute('data-element-id', element.id);
      circle.setAttribute('data-anchor-position', position);
      circle.style.display = 'none';
      circle.style.cursor = 'crosshair';
      this.svgElement.appendChild(circle);
    });
  }

  /**
   * 删除元素
   */
  deleteElement(group) {
    const elementId = group.getAttribute('data-editable');

    group.querySelectorAll('.anchor-point').forEach(anchor => anchor.remove());

    const connectionsToRemove = this.connections.filter(
      conn => conn.startElement === elementId || conn.endElement === elementId
    );

    connectionsToRemove.forEach(conn => {
      conn.path.remove();
      const index = this.connections.indexOf(conn);
      if (index > -1) this.connections.splice(index, 1);
    });

    const index = this.editableElements.findIndex(el => el.id === elementId);
    if (index > -1) this.editableElements.splice(index, 1);

    group.remove();
    this.selectedElement = null;
    this.saveState();
  }

  /**
   * 编辑元素文本
   */
  editElementText(group) {
    const textElement = group.querySelector('text');
    if (!textElement) return;

    const currentText = textElement.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentText;
    input.style.position = 'absolute';
    input.style.fontSize = '14px';

    const bbox = textElement.getBoundingClientRect();
    input.style.left = `${bbox.left}px`;
    input.style.top = `${bbox.top}px`;
    input.style.width = `${bbox.width}px`;

    document.body.appendChild(input);
    input.focus();
    input.select();

    let isFinished = false;

    const removeInput = () => {
      if (isFinished) return;
      isFinished = true;
      if (input.parentNode === document.body) {
        document.body.removeChild(input);
      }
    };

    const finishEdit = () => {
      if (isFinished) return;
      textElement.textContent = input.value;
      removeInput();

      const elementId = group.getAttribute('data-editable');
      const element = this.editableElements.find(el => el.id === elementId);
      if (element) element.label = input.value;
      this.saveState();
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        finishEdit();
      }
      if (e.key === 'Escape') {
        removeInput();
      }
    });
  }

  /**
   * 添加工具栏
   */
  addToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'canvas-toolbar';
    toolbar.innerHTML = `
      <button type="button" class="tool-btn active" data-tool="select" title="选择工具">
        <span class="tool-icon">☝️</span>
      </button>
      <button type="button" class="tool-btn" data-tool="move" title="移动工具">
        <span class="tool-icon">✋</span>
      </button>
      <button type="button" class="tool-btn" data-tool="connect" title="连线工具">
        <span class="tool-icon">🔗</span>
      </button>
      <div class="tool-separator"></div>
      <button type="button" class="tool-btn" data-tool="rectangle" title="添加矩形">
        <span class="tool-icon">▢</span>
      </button>
      <button type="button" class="tool-btn" data-tool="ellipse" title="添加椭圆">
        <span class="tool-icon">⬭</span>
      </button>
      <button type="button" class="tool-btn" data-tool="diamond" title="添加菱形">
        <span class="tool-icon">◇</span>
      </button>
      <div class="tool-separator"></div>
      <button type="button" class="tool-btn" id="btn-delete-element" title="删除选中元素">
        <span class="tool-icon">🗑️</span>
      </button>
      <div class="tool-separator"></div>
      <button type="button" class="tool-btn" id="btn-undo" title="撤销 (Ctrl+Z)">
        <span class="tool-icon">↩️</span>
      </button>
      <button type="button" class="tool-btn" id="btn-redo" title="重做 (Ctrl+Y)">
        <span class="tool-icon">↪️</span>
      </button>
      <div class="tool-separator"></div>
      <button type="button" class="tool-btn primary" id="btn-export-svg" title="导出 SVG">
        SVG
      </button>
      <button type="button" class="tool-btn primary" id="btn-export-png" title="导出 PNG">
        PNG
      </button>
    `;

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

    const style = document.createElement('style');
    style.textContent = `
      .canvas-toolbar .tool-btn {
        width: 32px;
        height: 32px;
        border: 1px solid transparent;
        border-radius: 6px;
        background: transparent;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #59636e;
        transition: all 0.2s;
      }
      .canvas-toolbar .tool-btn:hover {
        background: #f6f8fa;
        color: #0969da;
      }
      .canvas-toolbar .tool-btn.active {
        background: #0969da;
        color: white;
      }
      .canvas-toolbar .tool-btn.primary {
        width: auto;
        padding: 0 12px;
        font-size: 12px;
        background: #0969da;
        color: white;
        border: none;
      }
      .canvas-toolbar .tool-btn.primary:hover {
        background: #0550ae;
      }
      .canvas-toolbar .tool-separator {
        width: 1px;
        height: 24px;
        background: #d0d7de;
        margin: 4px 4px;
      }
    `;

    document.head.appendChild(style);
    this.container.appendChild(toolbar);
    this.toolbar = toolbar;

    toolbar.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => {
        toolbar.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.tool = btn.dataset.tool;
      });
    });

    toolbar.querySelector('#btn-delete-element')?.addEventListener('click', () => {
      if (this.selectedElement) {
        this.deleteElement(this.selectedElement);
      }
    });

    toolbar.querySelector('#btn-undo')?.addEventListener('click', () => this.undo());
    toolbar.querySelector('#btn-redo')?.addEventListener('click', () => this.redo());

    toolbar.querySelector('#btn-export-svg')?.addEventListener('click', () => this.exportAsSVG());
    toolbar.querySelector('#btn-export-png')?.addEventListener('click', () => this.exportAsPNG());
  }

  /**
   * 添加网格背景
   */
  addGridBackground() {
    const svgRect = this.svgElement.getBoundingClientRect();
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');

    const pattern = document.createElementNS('http://www.w3.org/2000/svg', 'pattern');
    pattern.setAttribute('id', 'grid');
    pattern.setAttribute('width', '20');
    pattern.setAttribute('height', '20');
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M 20 0 L 0 0 0 20');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#f0f0f0');
    path.setAttribute('stroke-width', '1');

    pattern.appendChild(path);
    defs.appendChild(pattern);
    this.svgElement.insertBefore(defs, this.svgElement.firstChild);

    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('fill', 'url(#grid)');
    this.svgElement.insertBefore(rect, this.svgElement.firstChild);
  }

  /**
   * 保存状态（用于撤销/重做）
   */
  saveState() {
    const state = {
      elements: this.editableElements.map(el => ({
        id: el.id,
        label: el.label,
        transform: el.group.getAttribute('transform')
      })),
      connections: this.connections.map(conn => ({
        d: conn.path.getAttribute('d')
      }))
    };
    this.undoStack.push(JSON.stringify(state));
    this.redoStack = [];
  }

  /**
   * 撤销
   */
  undo() {
    if (this.undoStack.length <= 1) return;

    const currentState = this.undoStack.pop();
    this.redoStack.push(currentState);

    const prevState = JSON.parse(this.undoStack[this.undoStack.length - 1]);
    this.restoreState(prevState);
  }

  /**
   * 重做
   */
  redo() {
    if (this.redoStack.length === 0) return;

    const nextState = JSON.parse(this.redoStack.pop());
    this.undoStack.push(JSON.stringify(nextState));
    this.restoreState(nextState);
  }

  /**
   * 恢复状态
   */
  restoreState(state) {
    state.elements.forEach(elState => {
      const element = this.editableElements.find(el => el.id === elState.id);
      if (element) {
        if (elState.transform) {
          element.group.setAttribute('transform', elState.transform);
        }
        element.label = elState.label;
        const textEl = element.group.querySelector('text');
        if (textEl) textEl.textContent = elState.label;
      }
    });

    state.connections.forEach((connState, index) => {
      if (this.connections[index]) {
        this.connections[index].path.setAttribute('d', connState.d);
      }
    });
  }

  /**
   * 导出为 SVG
   */
  exportAsSVG() {
    const clone = this.svgElement.cloneNode(true);

    clone.querySelectorAll('.anchor-point, .temp-connection').forEach(el => el.remove());
    clone.querySelectorAll('[style*="cursor"]').forEach(el => el.style.cursor = '');

    const svgData = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgData], { type: 'image/svg+xml' });

    if (this.onExportCallback) {
      this.onExportCallback({ kind: 'svg', svgText: svgData, blob: blob });
    }

    return blob;
  }

  /**
   * 导出为 PNG
   */
  exportAsPNG() {
    return new Promise((resolve) => {
      const clone = this.svgElement.cloneNode(true);

      clone.querySelectorAll('.anchor-point, .temp-connection').forEach(el => el.remove());

      const svgData = new XMLSerializer().serializeToString(clone);
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(svgBlob);

      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width * 2;
        canvas.height = img.height * 2;

        const ctx = canvas.getContext('2d');
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);

        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);

          if (this.onExportCallback) {
            this.onExportCallback({ kind: 'png', blob: blob });
          }

          resolve(blob);
        }, 'image/png');
      };
      img.src = url;
    });
  }

  /**
   * 销毁编辑器
   */
  destroy() {
    if (this.toolbar) {
      this.toolbar.remove();
    }
    document.querySelectorAll('.anchor-point, .temp-connection').forEach(el => el.remove());
  }
}

/**
 * 创建画板编辑器实例
 */
function createCanvasEditor(container, svgElement) {
  const editor = new CanvasEditor(container);
  editor.init(svgElement);
  return editor;
}

export { CanvasEditor, createCanvasEditor };