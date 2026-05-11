/**
 * mxGraph 编辑器模块 - 本地化版本
 */

class MxGraphEditor {
  constructor(container) {
    this.container = container;
    this.graph = null;
    this.isInitialized = false;
    this.onExportCallback = null;
    this.currentXml = null;
    this.isSpacePressed = false;
    this.isPanning = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;
    this.toolbar = null;
    /** @type {Array<() => void>} */
    this._cleanups = [];
    this._resizeHandler = null;
    this._toolbarDragState = { isDragging: false, startX: 0, startY: 0, initialX: 0, initialY: 0 };
    /** destroy() 后置为 true，供全局监听在未移除前短路 */
    this._released = false;
  }

  _addCleanup(fn) {
    if (typeof fn === 'function') this._cleanups.push(fn);
  }

  _runCleanups() {
    while (this._cleanups.length) {
      const fn = this._cleanups.pop();
      try {
        fn();
      } catch (e) {
        console.warn('MxGraphEditor cleanup:', e);
      }
    }
  }

  /**
   * 表单控件、可编辑区或已打开的 dialog 内的键盘事件不应由画板全局快捷键处理。
   * @param {EventTarget | null} target
   */
  shouldIgnoreHostShortcuts(target) {
    if (!target) return false;
    const el = /** @type {HTMLElement} */ (target);
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
    if (el.isContentEditable) return true;
    if (typeof el.closest === 'function' && el.closest('dialog[open]')) return true;
    return false;
  }

  async init() {
    if (this.isInitialized) return;

    return new Promise((resolve) => {
      this.loadMxGraph().then(() => {
        try {
          this.createEditor();
          this.isInitialized = true;
          resolve();
        } catch (error) {
          console.error('mxGraph init error:', error);
          this.createFallbackEditor();
          this.isInitialized = true;
          resolve();
        }
      }).catch(err => {
        console.error('Failed to load mxGraph:', err);
        this.createFallbackEditor();
        this.isInitialized = true;
        resolve();
      });
    });
  }

  loadMxGraph() {
    return new Promise((resolve, reject) => {
      if (window.mxClient && window.mxClient.isBrowserSupported) {
        window.mxBasePath = './lib/mxgraph/javascript/src/';
        resolve();
        return;
      }

      const basePath = './lib/mxgraph/javascript/src/';
      window.mxBasePath = basePath;

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = basePath + 'css/common.css';
      link.onerror = () => console.warn('CSS not found');
      document.head.appendChild(link);

      const script = document.createElement('script');
      script.src = './lib/mxgraph/javascript/mxClient.js';
      script.onload = () => {
        resolve();
      };
      script.onerror = (e) => {
        console.error('Failed to load mxGraph:', e);
        reject(e);
      };
      document.head.appendChild(script);
    });
  }

  createFallbackEditor() {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }

    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 600;
    canvas.style.cssText = 'width: 100%; height: 100%; background: #f6f8fa;';
    this.container.appendChild(canvas);

    this.setupToolbar();
    this.setupSpacePan();
  }

  createEditor() {
    while (this.container.firstChild) {
      this.container.removeChild(this.container.firstChild);
    }

    if (!window.mxClient || !window.mxClient.isBrowserSupported()) {
      console.error('mxGraph not supported');
      this.createFallbackEditor();
      return;
    }

    const mx = window;
    this.mx = mx;

    try {
      this.graph = new mx.mxGraph(this.container);
    } catch (e) {
      console.error('Failed to create mxGraph:', e);
      console.error('Available mx properties:', Object.keys(mx).filter(k => k.startsWith('mx')));
      this.createFallbackEditor();
      return;
    }

    this.graph.setConnectable(true);
    this.graph.setCellsEditable(true);
    this.graph.setAllowDanglingEdges(false);
    this.graph.setCellsResizable(true);
    this.graph.setPanning(true);
    this.graph.setTooltips(true);
    this.graph.setBorder(20);

    if (mx.mxUndoManager) {
      const undoManager = new mx.mxUndoManager(this.graph.getModel());
      this.graph.getModel().undoManager = undoManager;
      if (this.graph.getModel().addListener) {
        this.graph.getModel().addListener('undo', () => {
          undoManager.notify();
        });
      }
    }

    const style = this.graph.getStylesheet().getDefaultVertexStyle();
    style[mx.mxConstants.STYLE_FONTFAMILY] = 'Arial';
    style[mx.mxConstants.STYLE_FONTSIZE] = '12';
    style[mx.mxConstants.STYLE_FILLCOLOR] = 'white';
    style[mx.mxConstants.STYLE_STROKECOLOR] = 'black';
    style[mx.mxConstants.STYLE_STROKEWIDTH] = '2';
    style[mx.mxConstants.STYLE_ROUNDED] = true;
    style[mx.mxConstants.STYLE_ARCSIZE] = 8;

    const edgeStyle = this.graph.getStylesheet().getDefaultEdgeStyle();
    edgeStyle[mx.mxConstants.STYLE_STROKECOLOR] = 'black';
    edgeStyle[mx.mxConstants.STYLE_STROKEWIDTH] = '2';
    edgeStyle[mx.mxConstants.STYLE_ENDARROW] = mx.mxConstants.ARROW_CLASSIC;

    this.setupToolbar();
    this.setupKeyboardShortcuts();
    this.setupSpacePan();

    const keyHandler = new mx.mxKeyHandler(this.graph);
    keyHandler.bindKey(46, (evt) => {
      if (this.graph.isEnabled() && !this.isSpacePressed) {
        this.graph.removeCells(this.graph.getSelectionCells());
      }
    });
    keyHandler.bindKey(8, (evt) => {
      if (this.graph.isEnabled() && !this.isSpacePressed) {
        this.graph.removeCells(this.graph.getSelectionCells());
      }
    });

    keyHandler.bindKey(90, (evt) => {
      if (evt.ctrlKey || evt.metaKey) {
        evt.preventDefault();
        if (this.graph.getModel().canUndo()) {
          this.graph.getModel().undo();
        }
      }
    });

    keyHandler.bindKey(89, (evt) => {
      if (evt.ctrlKey || evt.metaKey) {
        evt.preventDefault();
        if (this.graph.getModel().canRedo()) {
          this.graph.getModel().redo();
        }
      }
    });

    keyHandler.bindKey(67, (evt) => {
      if (evt.ctrlKey || evt.metaKey) {
        evt.preventDefault();
        const cells = this.graph.getSelectionCells();
        if (cells.length > 0) {
          this.graph.copy(cells);
        }
      }
    });

    keyHandler.bindKey(86, (evt) => {
      if (evt.ctrlKey || evt.metaKey) {
        evt.preventDefault();
        if (this.graph.clipboard.isEnabled()) {
          this.graph.paste();
        }
      }
    });

    keyHandler.bindKey(88, (evt) => {
      if (evt.ctrlKey || evt.metaKey) {
        evt.preventDefault();
        const cells = this.graph.getSelectionCells();
        if (cells.length > 0) {
          this.graph.cut(cells);
        }
      }
    });

    keyHandler.bindKey(65, (evt) => {
      if (evt.ctrlKey || evt.metaKey) {
        evt.preventDefault();
        const parent = this.graph.getDefaultParent();
        const model = this.graph.getModel();
        const cells = [];
        model.visit(parent, (cell) => {
          if (model.isVertex(cell) || model.isEdge(cell)) {
            cells.push(cell);
          }
          return true;
        });
        if (cells.length > 0) {
          this.graph.setSelectionCells(cells);
        }
      }
    });

    this._resizeHandler = () => {
      if (this.graph) {
        this.graph.sizeDidChange();
      }
    };
    mx.mxEvent.addListener(window, 'resize', this._resizeHandler);
    this._addCleanup(() => {
      try {
        mx.mxEvent.removeListener(window, 'resize', this._resizeHandler);
      } catch (e) {
        /* ignore */
      }
    });
  }

  setupKeyboardShortcuts() {
    const container = this.container;

    const onSpaceKeydown = (e) => {
      if (this._released) return;
      if (this.shouldIgnoreHostShortcuts(e.target)) return;
      if (e.code === 'Space' && !this.isSpacePressed) {
        e.preventDefault();
        this.isSpacePressed = true;
        container.style.cursor = 'grab';
      }
    };
    document.addEventListener('keydown', onSpaceKeydown);
    this._addCleanup(() => document.removeEventListener('keydown', onSpaceKeydown));

    const onSpaceKeyup = (e) => {
      if (this._released) return;
      if (this.shouldIgnoreHostShortcuts(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        this.isSpacePressed = false;
        this.isPanning = false;
        container.style.cursor = 'default';
      }
    };
    document.addEventListener('keyup', onSpaceKeyup);
    this._addCleanup(() => document.removeEventListener('keyup', onSpaceKeyup));

    const onCaptureKeydown = (e) => {
      if (this._released || !this.graph) return;
      if (this.shouldIgnoreHostShortcuts(e.target)) return;

      const ctrlOrCmd = e.ctrlKey || e.metaKey;

      if (ctrlOrCmd) {
        const mxRef = window.mxClient || window;
        switch (e.key.toLowerCase()) {
          case 'z':
            e.preventDefault();
            e.stopPropagation();
            if (this.graph.getModel().undoManager && this.graph.getModel().undoManager.canUndo()) {
              this.graph.getModel().undoManager.undo();
            } else if (typeof this.graph.getModel().undo === 'function') {
              this.graph.getModel().undo();
            }
            break;
          case 'y':
            e.preventDefault();
            e.stopPropagation();
            if (this.graph.getModel().undoManager && this.graph.getModel().undoManager.canRedo()) {
              this.graph.getModel().undoManager.redo();
            } else if (typeof this.graph.getModel().redo === 'function') {
              this.graph.getModel().redo();
            }
            break;
          case 'c': {
            e.preventDefault();
            e.stopPropagation();
            const cellsCopy = this.graph.getSelectionCells();
            if (cellsCopy.length > 0 && mxRef.mxClipboard) {
              if (typeof mxRef.mxClipboard.copy === 'function') {
                mxRef.mxClipboard.copy(cellsCopy);
              } else if (typeof mxRef.mxClipboard.putCells === 'function') {
                mxRef.mxClipboard.putCells(cellsCopy);
              } else if (typeof mxRef.mxClipboard.setData === 'function') {
                const encoder = new mxRef.mxCodec();
                const xml = encoder.encode(cellsCopy);
                mxRef.mxClipboard.setData(xml);
              }
            }
            break;
          }
          case 'v': {
            e.preventDefault();
            e.stopPropagation();
            if (mxRef.mxClipboard) {
              const parent = this.graph.getDefaultParent();
              const model = this.graph.getModel();
              model.beginUpdate();
              try {
                let cells = null;
                if (typeof mxRef.mxClipboard.getCells === 'function') {
                  cells = mxRef.mxClipboard.getCells();
                } else if (typeof mxRef.mxClipboard.getData === 'function') {
                  const data = mxRef.mxClipboard.getData();
                  if (data) {
                    const decoder = new mxRef.mxCodec();
                    cells = decoder.decode(data);
                  }
                }

                if (cells && cells.length > 0) {
                  const clones = [];
                  for (let i = 0; i < cells.length; i++) {
                    const clone = model.cloneCell(cells[i]);
                    clones.push(clone);
                  }
                  const result = this.graph.addCells(clones, 20, 20, parent);
                  if (result && result.length > 0) {
                    this.graph.setSelectionCells(result);
                  }
                }
              } finally {
                model.endUpdate();
              }
            }
            break;
          }
          case 'x': {
            e.preventDefault();
            e.stopPropagation();
            const cellsCut = this.graph.getSelectionCells();
            if (cellsCut.length > 0 && mxRef.mxClipboard && typeof mxRef.mxClipboard.copy === 'function') {
              mxRef.mxClipboard.copy(cellsCut);
              this.graph.removeCells(cellsCut);
            }
            break;
          }
          case 'a': {
            e.preventDefault();
            e.stopPropagation();
            const parent = this.graph.getDefaultParent();
            const childCells = this.graph.getChildCells(parent);
            const allCells = [];
            for (let i = 0; i < childCells.length; i++) {
              const cell = childCells[i];
              if (this.graph.getModel().isVertex(cell) || this.graph.getModel().isEdge(cell)) {
                allCells.push(cell);
              }
            }
            if (allCells.length > 0) {
              this.graph.setSelectionCells(allCells);
            }
            break;
          }
        }
      }
    };
    document.addEventListener('keydown', onCaptureKeydown, true);
    this._addCleanup(() => document.removeEventListener('keydown', onCaptureKeydown, true));
  }

  setupSpacePan() {
    const container = this.container;

    const onMouseDown = (e) => {
      if (this._released) return;
      if (this.isSpacePressed) {
        e.preventDefault();
        this.isPanning = true;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;
        container.style.cursor = 'grabbing';
      }
    };
    container.addEventListener('mousedown', onMouseDown);
    this._addCleanup(() => container.removeEventListener('mousedown', onMouseDown));

    const onMouseMove = (e) => {
      if (this._released) return;
      if (this.isPanning) {
        e.preventDefault();
        const dx = e.clientX - this.lastMouseX;
        const dy = e.clientY - this.lastMouseY;
        this.lastMouseX = e.clientX;
        this.lastMouseY = e.clientY;

        if (this.graph) {
          const view = this.graph.getView();
          view.setTranslate(view.translate.x + dx, view.translate.y + dy);
        } else {
          container.scrollLeft -= dx;
          container.scrollTop -= dy;
        }
      }
    };
    container.addEventListener('mousemove', onMouseMove);
    this._addCleanup(() => container.removeEventListener('mousemove', onMouseMove));

    const onMouseUp = () => {
      if (this._released) return;
      if (this.isPanning) {
        this.isPanning = false;
        container.style.cursor = this.isSpacePressed ? 'grab' : 'default';
      }
    };
    container.addEventListener('mouseup', onMouseUp);
    this._addCleanup(() => container.removeEventListener('mouseup', onMouseUp));

    const onMouseLeave = () => {
      if (this._released) return;
      if (this.isPanning) {
        this.isPanning = false;
        if (this.isSpacePressed) {
          container.style.cursor = 'grab';
        }
      }
    };
    container.addEventListener('mouseleave', onMouseLeave);
    this._addCleanup(() => container.removeEventListener('mouseleave', onMouseLeave));
  }

  setupToolbar() {
    const toolbar = document.createElement('div');
    toolbar.id = 'mx-toolbar';
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
      cursor: move;
      user-select: none;
      min-width: 320px;
    `;

    toolbar.innerHTML = `
      <button type="button" id="mx-btn-select" title="选择工具 (V)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: #0969da; color: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">☝️</button>
      <button type="button" id="mx-btn-rectangle" title="添加矩形 (R)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">▢</button>
      <button type="button" id="mx-btn-ellipse" title="添加椭圆 (E)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">⬭</button>
      <button type="button" id="mx-btn-diamond" title="添加菱形 (D)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">◇</button>
      <div style="width: 1px; height: 28px; background: #d0d7de; margin: 4px 4px;"></div>
      <button type="button" id="mx-btn-line" title="添加连接线 (L)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">→</button>
      <div style="width: 1px; height: 28px; background: #d0d7de; margin: 4px 4px;"></div>
      <button type="button" id="mx-btn-delete" title="删除 (Del)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">🗑️</button>
      <div style="width: 1px; height: 28px; background: #d0d7de; margin: 4px 4px;"></div>
      <button type="button" id="mx-btn-export-svg" title="导出 SVG" style="width: auto; padding: 0 12px; height: 36px; border: none; border-radius: 6px; background: #2da44e; color: white; cursor: pointer; font-size: 12px;">SVG</button>
      <button type="button" id="mx-btn-export-png" title="导出 PNG" style="width: auto; padding: 0 12px; height: 36px; border: none; border-radius: 6px; background: #2da44e; color: white; cursor: pointer; font-size: 12px;">PNG</button>
      <div style="width: 1px; height: 28px; background: #d0d7de; margin: 4px 4px;"></div>
      <button type="button" id="mx-btn-zoom-in" title="放大 (+)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px;">+</button>
      <button type="button" id="mx-btn-zoom-out" title="缩小 (-)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 18px;">−</button>
      <button type="button" id="mx-btn-zoom-reset" title="重置缩放 (0)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;">⟲</button>
      <div style="width: 1px; height: 28px; background: #d0d7de; margin: 4px 4px;"></div>
      <button type="button" id="mx-btn-fullscreen" title="全屏 (F)" style="width: 36px; height: 36px; border: 1px solid #d0d7de; border-radius: 6px; background: white; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 16px;">⛶</button>
    `;

    this.container.appendChild(toolbar);
    this.toolbar = toolbar;

    this.makeToolbarDraggable();
    this.bindToolbarEvents();
  }

  makeToolbarDraggable() {
    const toolbar = this.toolbar;
    const st = this._toolbarDragState;

    const onToolbarMouseDown = (e) => {
      if (e.target.tagName === 'BUTTON') return;

      st.isDragging = true;
      st.startX = e.clientX;
      st.startY = e.clientY;

      const rect = toolbar.getBoundingClientRect();
      st.initialX = rect.left;
      st.initialY = rect.top;

      toolbar.style.cursor = 'grabbing';
      e.preventDefault();
    };
    toolbar.addEventListener('mousedown', onToolbarMouseDown);
    this._addCleanup(() => toolbar.removeEventListener('mousedown', onToolbarMouseDown));

    const onDocMouseMove = (e) => {
      if (this._released || !st.isDragging) return;

      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;

      let newX = st.initialX + dx;
      let newY = st.initialY + dy;

      const containerRect = this.container.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();

      newX = Math.max(0, Math.min(newX, containerRect.width - toolbarRect.width));
      newY = Math.max(0, Math.min(newY, containerRect.height - toolbarRect.height));

      toolbar.style.left = newX + 'px';
      toolbar.style.top = newY + 'px';
      toolbar.style.right = 'auto';
    };
    document.addEventListener('mousemove', onDocMouseMove);
    this._addCleanup(() => document.removeEventListener('mousemove', onDocMouseMove));

    const onDocMouseUp = () => {
      if (st.isDragging) {
        st.isDragging = false;
        if (toolbar) toolbar.style.cursor = 'move';
      }
    };
    document.addEventListener('mouseup', onDocMouseUp);
    this._addCleanup(() => document.removeEventListener('mouseup', onDocMouseUp));
  }

  bindToolbarEvents() {
    const toolbar = this.toolbar;
    if (!toolbar) return;

    const selectBtn = toolbar.querySelector('#mx-btn-select');
    const rectBtn = toolbar.querySelector('#mx-btn-rectangle');
    const ellipseBtn = toolbar.querySelector('#mx-btn-ellipse');
    const diamondBtn = toolbar.querySelector('#mx-btn-diamond');
    const lineBtn = toolbar.querySelector('#mx-btn-line');
    const deleteBtn = toolbar.querySelector('#mx-btn-delete');
    const svgBtn = toolbar.querySelector('#mx-btn-export-svg');
    const pngBtn = toolbar.querySelector('#mx-btn-export-png');
    const zoomInBtn = toolbar.querySelector('#mx-btn-zoom-in');
    const zoomOutBtn = toolbar.querySelector('#mx-btn-zoom-out');
    const zoomResetBtn = toolbar.querySelector('#mx-btn-zoom-reset');
    const fullscreenBtn = toolbar.querySelector('#mx-btn-fullscreen');

    if (selectBtn) {
      selectBtn.addEventListener('click', () => {
        if (this.graph) {
          this.graph.setEnabled(true);
        }
        this.updateButtonStyles('mx-btn-select');
      });
    }

    if (rectBtn) {
      rectBtn.addEventListener('click', () => this.addRectangle());
    }

    if (ellipseBtn) {
      ellipseBtn.addEventListener('click', () => this.addEllipse());
    }

    if (diamondBtn) {
      diamondBtn.addEventListener('click', () => this.addDiamond());
    }

    if (lineBtn) {
      lineBtn.addEventListener('click', () => this.addArrow());
    }

    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => this.deleteSelected());
    }

    if (svgBtn) {
      svgBtn.addEventListener('click', () => this.exportSVG());
    }

    if (pngBtn) {
      pngBtn.addEventListener('click', () => this.exportPNG());
    }

    if (zoomInBtn) {
      zoomInBtn.addEventListener('click', () => this.zoomIn());
    }

    if (zoomOutBtn) {
      zoomOutBtn.addEventListener('click', () => this.zoomOut());
    }

    if (zoomResetBtn) {
      zoomResetBtn.addEventListener('click', () => this.zoomReset());
    }

    if (fullscreenBtn) {
      fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
    }

    const onToolbarShortcutsKeydown = (e) => {
      if (this._released) return;
      if (this.shouldIgnoreHostShortcuts(e.target)) return;

      if (e.key === '+' || e.key === '=') {
        this.zoomIn();
      } else if (e.key === '-') {
        this.zoomOut();
      } else if (e.key === '0') {
        this.zoomReset();
      } else if (e.key === 'v' || e.key === 'V') {
        if (this.graph) this.graph.setEnabled(true);
        this.updateButtonStyles('mx-btn-select');
      } else if (e.key === 'r' || e.key === 'R') {
        this.addRectangle();
      } else if (e.key === 'e' || e.key === 'E') {
        this.addEllipse();
      } else if (e.key === 'd' || e.key === 'D') {
        this.addDiamond();
      } else if (e.key === 'l' || e.key === 'L') {
        this.addArrow();
      } else if (e.key === 'f' || e.key === 'F') {
        this.toggleFullscreen();
      }
    };
    document.addEventListener('keydown', onToolbarShortcutsKeydown);
    this._addCleanup(() => document.removeEventListener('keydown', onToolbarShortcutsKeydown));
  }

  zoomIn() {
    if (this.graph) {
      const view = this.graph.getView();
      const scale = view.scale * 1.2;
      view.setScale(scale);
    }
  }

  zoomOut() {
    if (this.graph) {
      const view = this.graph.getView();
      const scale = view.scale / 1.2;
      view.setScale(Math.max(0.1, scale));
    }
  }

  zoomReset() {
    if (this.graph) {
      const view = this.graph.getView();
      view.setScale(1);
      view.setTranslate(0, 0);
    }
  }

  toggleFullscreen() {
    const container = this.container;
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);

    if (isFullscreen) {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
      } else if (document.mozCancelFullScreen) {
        document.mozCancelFullScreen();
      } else if (document.msExitFullscreen) {
        document.msExitFullscreen();
      }
    } else {
      if (container.requestFullscreen) {
        container.requestFullscreen();
      } else if (container.webkitRequestFullscreen) {
        container.webkitRequestFullscreen();
      } else if (container.mozRequestFullScreen) {
        container.mozRequestFullScreen();
      } else if (container.msRequestFullscreen) {
        container.msRequestFullscreen();
      }
    }
  }

  updateButtonStyles(activeId) {
    if (!this.toolbar) return;
    
    this.toolbar.querySelectorAll('button').forEach(btn => {
      btn.style.background = 'white';
      btn.style.color = '#59636e';
    });
    const activeBtn = this.toolbar.querySelector(`#${activeId}`);
    if (activeBtn) {
      activeBtn.style.background = '#0969da';
      activeBtn.style.color = 'white';
    }
  }

  addRectangle() {
    if (!this.graph) return;
    
    this.graph.getModel().beginUpdate();
    try {
      const parent = this.graph.getDefaultParent();
      const x = 100 + Math.random() * 200;
      const y = 100 + Math.random() * 200;
      const vertex = this.graph.insertVertex(parent, null, '处理', x, y, 120, 60, 'rounded=1;whiteSpace=wrap;html=1;fillColor=white;strokeColor=black;strokeWidth=2;');
      this.graph.setSelectionCell(vertex);
    } finally {
      this.graph.getModel().endUpdate();
    }
  }

  addEllipse() {
    if (!this.graph) return;
    
    this.graph.getModel().beginUpdate();
    try {
      const parent = this.graph.getDefaultParent();
      const x = 100 + Math.random() * 200;
      const y = 100 + Math.random() * 200;
      const vertex = this.graph.insertVertex(parent, null, '开始/结束', x, y, 100, 50, 'shape=ellipse;whiteSpace=wrap;html=1;fillColor=white;strokeColor=black;strokeWidth=2;');
      this.graph.setSelectionCell(vertex);
    } finally {
      this.graph.getModel().endUpdate();
    }
  }

  addDiamond() {
    if (!this.graph) return;
    
    this.graph.getModel().beginUpdate();
    try {
      const parent = this.graph.getDefaultParent();
      const x = 100 + Math.random() * 200;
      const y = 100 + Math.random() * 200;
      const vertex = this.graph.insertVertex(parent, null, '判断', x, y, 80, 60, 'shape=rhombus;whiteSpace=wrap;html=1;fillColor=white;strokeColor=black;strokeWidth=2;');
      this.graph.setSelectionCell(vertex);
    } finally {
      this.graph.getModel().endUpdate();
    }
  }

  addArrow() {
    if (!this.graph) return;
    
    const cells = this.graph.getSelectionCells();
    if (cells.length === 0) return;

    const source = cells[0];
    this.graph.getModel().beginUpdate();
    try {
      const parent = this.graph.getDefaultParent();
      const targetX = source.geometry.x + source.geometry.width + 100;
      const targetY = source.geometry.y;
      const target = this.graph.insertVertex(parent, null, '', targetX, targetY, 1, 1);
      const edge = this.graph.insertEdge(parent, null, '', source, target, 'arrowStyle=classic;html=1;strokeColor=black;endArrow=classic;strokeWidth=2;');
      this.graph.setSelectionCell(edge);
    } finally {
      this.graph.getModel().endUpdate();
    }
  }

  deleteSelected() {
    if (!this.graph) return;
    
    const cells = this.graph.getSelectionCells();
    if (cells.length > 0) {
      this.graph.removeCells(cells);
    }
  }

  importXML(xml) {
    if (!this.graph || !xml || xml.trim() === '') return;

    this.graph.getModel().beginUpdate();
    try {
      const doc = this.mx.mxUtils.parseXml(xml);
      if (!doc || !doc.documentElement) {
        console.error('Failed to parse XML');
        return;
      }
      const decoder = new this.mx.mxCodec(doc);
      decoder.decode(doc.documentElement, this.graph.getModel());
      this.currentXml = xml;
    } catch (error) {
      console.error('Error importing XML:', error);
      console.error('XML content:', xml.substring(0, 500));
    } finally {
      this.graph.getModel().endUpdate();
    }
  }

  exportXML() {
    if (!this.graph) return '';
    
    const encoder = new this.mx.mxCodec();
    const xml = encoder.encode(this.graph.getModel());
    this.currentXml = this.mx.mxUtils.getPrettyXml(xml);
    return this.currentXml;
  }

  exportSVG() {
    if (!this.graph) return;
    
    const scale = 2;
    const bg = '#FFFFFF';
    const svg = this.graph.createSvg(scale, bg, this.graph.getBounds(), null, false, false, null);

    if (svg && this.onExportCallback) {
      const svgData = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([svgData], { type: 'image/svg+xml' });
      this.onExportCallback({ kind: 'svg', svgText: svgData, blob: blob });
    }
  }

  exportPNG() {
    if (!this.graph) return;
    
    const scale = 2;
    const bg = '#FFFFFF';
    const img = this.graph.createImage(scale, bg, this.graph.getBounds(), null, false, false, null);

    if (img) {
      img.addEventListener('load', () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        canvas.toBlob((blob) => {
          if (this.onExportCallback) {
            this.onExportCallback({ kind: 'png', blob: blob });
          }
        }, 'image/png');
      });
      img.src = img.src;
    }
  }

  destroy() {
    this._released = true;
    this.isSpacePressed = false;
    this.isPanning = false;
    this._toolbarDragState.isDragging = false;
    this._runCleanups();

    if (this.toolbar) {
      this.toolbar.remove();
      this.toolbar = null;
    }
    if (this.graph) {
      try {
        this.graph.destroy();
      } catch (e) {
        console.warn('mxGraph destroy:', e);
      }
      this.graph = null;
    }
    if (this.container) {
      this.container.style.cursor = '';
    }
    this.isInitialized = false;
  }
}

class PlantUMLToMxGraphConverter {
  constructor() {
    this.nodeIdCounter = 2;
    this.edgeIdCounter = 0;
    this.vertices = [];
    this.edges = [];
    this.spacingY = 120;
    this.spacingX = 200;
  }

  reset() {
    this.nodeIdCounter = 2;
    this.edgeIdCounter = 0;
    this.vertices = [];
    this.edges = [];
  }

  newId() {
    return this.nodeIdCounter++;
  }

  newEdgeId() {
    return 2000 + this.edgeIdCounter++;
  }

  convert(plantumlSource) {
    this.reset();
    
    const normalized = this.normalizeSource(plantumlSource);
    const ast = this.parseAST(normalized);
    this.layoutAST(ast);
    
    return this.toMxGraphXML(this.vertices, this.edges);
  }

  normalizeSource(source) {
    let lines = source.split('\n');
    const result = [];
    
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i].trim();
      
      if (line.match(/^@startuml/i) || line.match(/^@enduml/i)) {
        continue;
      }
      
      if (line.match(/^title\s+/i)) {
        continue;
      }
      
      if (line.match(/^skinparam\s+/i)) {
        continue;
      }
      
      if (line.match(/^<style>/i)) {
        continue;
      }
      
      if (line.match(/^<\/style>/i)) {
        continue;
      }
      
      if (line.match(/^\[.*\]\s*->/i) || line.match(/^->/i)) {
        continue;
      }
      
      line = line.replace(/<<[^>]+>>/g, '').trim();
      
      if (!line) continue;
      
      result.push(line);
    }
    
    return result;
  }

  parseAST(lines) {
    const ast = { nodes: [], edges: [] };
    let i = 0;
    let lastNode = null;
    let currentY = 50;
    
    while (i < lines.length) {
      const line = lines[i];
      
      if (line === 'start' || line === 'Start' || line === 'START') {
        const node = { id: this.newId(), type: 'start', text: '开始', y: currentY };
        ast.nodes.push(node);
        if (lastNode) {
          ast.edges.push({ source: lastNode.id, target: node.id });
        }
        lastNode = node;
        currentY += this.spacingY;
        i++;
      } else if (line === 'stop' || line === 'Stop' || line === 'STOP') {
        const node = { id: this.newId(), type: 'stop', text: '结束', y: currentY };
        ast.nodes.push(node);
        if (lastNode) {
          ast.edges.push({ source: lastNode.id, target: node.id });
        }
        lastNode = node;
        currentY += this.spacingY;
        i++;
      } else if (line.startsWith(':') && line.endsWith(';')) {
        const text = line.slice(1, -1).trim();
        if (text && text !== '开始' && text !== '结束') {
          const node = { id: this.newId(), type: 'action', text: text, y: currentY };
          ast.nodes.push(node);
          if (lastNode) {
            ast.edges.push({ source: lastNode.id, target: node.id });
          }
          lastNode = node;
          currentY += this.spacingY;
        }
        i++;
      } else if (line.startsWith('if')) {
        const conditionMatch = line.match(/if\s*\(\s*([^)]+?)\s*\)/);
        const condition = conditionMatch ? conditionMatch[1].trim() : '条件';
        
        const thenMatch = line.match(/then\s*\(\s*([^)]+?)\s*\)/i);
        const yesLabel = thenMatch ? thenMatch[1].trim() : '是';
        
        const node = { 
          id: this.newId(), 
          type: 'decision', 
          text: condition, 
          y: currentY,
          yesLabel: yesLabel,
          noLabel: '否'
        };
        ast.nodes.push(node);
        
        if (lastNode) {
          ast.edges.push({ source: lastNode.id, target: node.id });
        }
        lastNode = node;
        currentY += this.spacingY;
        
        i++;
        let depth = 1;
        
        while (i < lines.length && depth > 0) {
          const innerLine = lines[i];
          
          if (innerLine.startsWith('if')) {
            depth++;
            const innerConditionMatch = innerLine.match(/if\s*\(\s*([^)]+?)\s*\)/);
            const innerCondition = innerConditionMatch ? innerConditionMatch[1].trim() : '条件';
            
            const innerThenMatch = innerLine.match(/then\s*\(\s*([^)]+?)\s*\)/i);
            const innerYesLabel = innerThenMatch ? innerThenMatch[1].trim() : '是';
            
            const innerNode = { 
              id: this.newId(), 
              type: 'decision', 
              text: innerCondition, 
              y: currentY,
              yesLabel: innerYesLabel,
              noLabel: '否'
            };
            ast.nodes.push(innerNode);
            
            if (lastNode) {
              ast.edges.push({ source: lastNode.id, target: innerNode.id });
            }
            lastNode = innerNode;
            currentY += this.spacingY;
          } else if (innerLine === 'endif') {
            depth--;
          } else if (innerLine.startsWith('else')) {
            const elseMatch = innerLine.match(/else\s*\(\s*([^)]+?)\s*\)/i);
            if (elseMatch) {
              node.noLabel = elseMatch[1].trim();
            }
          } else if (innerLine.startsWith(':') && innerLine.endsWith(';')) {
            const text = innerLine.slice(1, -1).trim();
            if (text) {
              const actionNode = { id: this.newId(), type: 'action', text: text, y: currentY };
              ast.nodes.push(actionNode);
              
              if (lastNode) {
                ast.edges.push({ source: lastNode.id, target: actionNode.id });
              }
              lastNode = actionNode;
              currentY += this.spacingY;
            }
          }
          
          i++;
        }
      } else {
        i++;
      }
    }
    
    return ast;
  }

  layoutAST(ast) {
    const mainX = 300;
    const decisionOffset = 0;
    const branchOffset = 150;
    
    let currentY = 50;
    
    for (let i = 0; i < ast.nodes.length; i++) {
      const node = ast.nodes[i];
      
      if (node.type === 'start') {
        this.vertices.push({
          id: node.id,
          text: node.text,
          x: mainX - 50,
          y: currentY,
          width: 100,
          height: 50,
          style: 'shape=ellipse;whiteSpace=wrap;html=1;fillColor=white;strokeColor=black;strokeWidth=2;'
        });
        currentY += 80;
      } else if (node.type === 'stop') {
        this.vertices.push({
          id: node.id,
          text: node.text,
          x: mainX - 50,
          y: currentY,
          width: 100,
          height: 50,
          style: 'shape=ellipse;whiteSpace=wrap;html=1;fillColor=white;strokeColor=black;strokeWidth=2;'
        });
      } else if (node.type === 'action') {
        const width = Math.max(120, node.text.length * 8 + 40);
        const x = mainX - width / 2;
        
        this.vertices.push({
          id: node.id,
          text: node.text,
          x: x,
          y: currentY,
          width: width,
          height: 60,
          style: 'rounded=1;whiteSpace=wrap;html=1;fillColor=white;strokeColor=black;strokeWidth=2;'
        });
        currentY += 80;
      } else if (node.type === 'decision') {
        const decisionX = mainX - decisionOffset;
        
        this.vertices.push({
          id: node.id,
          text: node.text,
          x: decisionX - 50,
          y: currentY,
          width: 100,
          height: 60,
          style: 'shape=rhombus;whiteSpace=wrap;html=1;fillColor=white;strokeColor=black;strokeWidth=2;'
        });
        
        const yesNodeId = this.newId();
        const noNodeId = this.newId();
        
        const yesNode = {
          id: yesNodeId,
          text: node.yesLabel,
          x: decisionX - branchOffset - 30,
          y: currentY + 30,
          width: 60,
          height: 30,
          style: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#E8F4FD;strokeColor=#0969DA;strokeWidth=1;'
        };
        
        const noNode = {
          id: noNodeId,
          text: node.noLabel,
          x: decisionX + branchOffset - 30,
          y: currentY + 30,
          width: 60,
          height: 30,
          style: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFF3E0;strokeColor=#E65100;strokeWidth=1;'
        };
        
        this.vertices.push(yesNode);
        this.vertices.push(noNode);
        
        node.yesLabelId = yesNodeId;
        node.noLabelId = noNodeId;
        
        currentY += 100;
      }
    }
    
    for (let i = 0; i < ast.nodes.length; i++) {
      const node = ast.nodes[i];
      const nextNode = ast.nodes[i + 1];
      
      if (nextNode && node.type !== 'decision') {
        this.edges.push({
          id: this.newEdgeId(),
          source: node.id,
          target: nextNode.id,
          style: 'html=1;strokeColor=black;endArrow=classic;strokeWidth=2;'
        });
      }
      
      if (node.type === 'decision' && nextNode) {
        this.edges.push({
          id: this.newEdgeId(),
          source: node.id,
          target: node.yesLabelId,
          style: 'html=1;strokeColor=black;endArrow=classic;strokeWidth=2;'
        });
        
        this.edges.push({
          id: this.newEdgeId(),
          source: node.id,
          target: node.noLabelId,
          style: 'html=1;strokeColor=black;endArrow=classic;strokeWidth=2;'
        });
        
        this.edges.push({
          id: this.newEdgeId(),
          source: node.yesLabelId,
          target: nextNode.id,
          style: 'html=1;strokeColor=#0969DA;endArrow=classic;strokeWidth=2;'
        });
        
        this.edges.push({
          id: this.newEdgeId(),
          source: node.noLabelId,
          target: nextNode.id,
          style: 'html=1;strokeColor=#E65100;endArrow=classic;strokeWidth=2;'
        });
      }
    }
  }

  toMxGraphXML(vertices, edges) {
    if (vertices.length === 0) {
      return `<?xml version="1.0" encoding="UTF-8"?>
<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
  </root>
</mxGraphModel>`;
    }

    const vertexIds = new Set(vertices.map(v => v.id));

    const validEdges = edges.filter(e => {
      if (!vertexIds.has(e.source)) {
        return false;
      }
      if (!vertexIds.has(e.target)) {
        return false;
      }
      return true;
    });

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
`;

    vertices.forEach(v => {
      xml += `    <mxCell id="${v.id}" value="${this.escapeXml(v.text)}" style="${v.style}" vertex="1" parent="1">
      <mxGeometry x="${v.x}" y="${v.y}" width="${v.width}" height="${v.height}" as="geometry"/>
    </mxCell>
`;
    });

    validEdges.forEach(e => {
      const style = e.style || 'html=1;strokeColor=black;endArrow=classic;strokeWidth=2;';
      xml += `    <mxCell id="${e.id}" style="${style}" edge="1" parent="1" source="${e.source}" target="${e.target}">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
`;
    });

    xml += `  </root>
</mxGraphModel>`;

    return xml;
  }

  escapeXml(text) {
    if (!text) return '';
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

window.MxGraphEditor = MxGraphEditor;
window.PlantUMLToMxGraphConverter = PlantUMLToMxGraphConverter;