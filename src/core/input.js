/**
 * 输入：键盘（WASD / 方向键）+ 触屏虚拟摇杆
 *
 * 相机为固定斜俯角，因此「屏幕向上」约等于「世界 -Z」。
 * 摇杆直接把屏幕位移映射到世界轴，斜俯角带来的手感受视角影响可忽略
 * （与 OT2 这类固定视角的做法一致）。
 *
 * 为什么用「按下即出现的浮动摇杆」而不是固定摇杆：
 *   固定摇杆要在窄屏上永久占掉一块视觉区域，而这个场景的画面本身就是主体。
 *   浮动摇杆只在手指按下时出现在手指位置，松开即消失，零常驻占用。
 */

const KEY_MAP = {
  KeyW: 'up', ArrowUp: 'up',
  KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right'
};

/** 摇杆的最大拖拽半径（CSS 像素）—— 超过就按比例截断 */
const STICK_RADIUS = 62;
/** 死区：小于这个位移视为静止，避免手指微抖导致角色漂移 */
const DEAD_ZONE = 6;

/** 触屏虚拟摇杆：仅在 pointerdown 后接管，pointerup 即销毁 */
class TouchStick {
  constructor(root) {
    this.root = root;
    this.el = root;
    this.activeId = null;
    this.ox = 0;
    this.oy = 0;
    this.dx = 0;
    this.dy = 0;
    this._bind();
  }

  _bind() {
    // 用 pointer 事件统一处理触摸与鼠标（移动端 Chrome 会同时派发 mouse 事件，
    // 若分开监听会导致一次点击触发两套逻辑）
    this._onDown = (e) => {
      if (this.activeId !== null) return;
      // 忽略落在 UI 元素上的按下
      if (e.target.closest('button, a, input')) return;
      this.activeId = e.pointerId;
      this.ox = e.clientX;
      this.oy = e.clientY;
      this.dx = 0;
      this.dy = 0;
      this._show();
      e.preventDefault();
    };
    this._onMove = (e) => {
      if (e.pointerId !== this.activeId) return;
      let vx = e.clientX - this.ox;
      let vy = e.clientY - this.oy;
      const len = Math.hypot(vx, vy);
      if (len > STICK_RADIUS) {
        vx = (vx / len) * STICK_RADIUS;
        vy = (vy / len) * STICK_RADIUS;
      }
      this.dx = vx;
      this.dy = vy;
      this._draw();
      e.preventDefault();
    };
    this._onUp = (e) => {
      if (e.pointerId !== this.activeId) return;
      this.activeId = null;
      this.dx = 0;
      this.dy = 0;
      this._hide();
    };

    this.el.addEventListener('pointerdown', this._onDown, { passive: false });
    window.addEventListener('pointermove', this._onMove, { passive: false });
    window.addEventListener('pointerup', this._onUp);
    window.addEventListener('pointercancel', this._onUp);
  }

  _show() {
    // 圆圈用 CSS 变量定位到按下点（元素本身铺满全屏，见 index.html 注释）
    this.el.style.setProperty('--ox', `${this.ox}px`);
    this.el.style.setProperty('--oy', `${this.oy}px`);
    this.el.classList.add('on');
  }

  _hide() {
    this.el.classList.remove('on');
  }

  /** 绘制摇杆的两个圆：外圈在按下点，内圈跟着手指 */
  _draw() {
    const len = Math.hypot(this.dx, this.dy);
    const ratio = len > DEAD_ZONE ? 1 : len / DEAD_ZONE;
    // 内圈朝拖拽方向最多偏移 STICK_RADIUS * 0.55
    const off = ratio * STICK_RADIUS * 0.55;
    const ang = Math.atan2(this.dy, this.dx);
    const kx = this.ox + Math.cos(ang) * off;
    const ky = this.oy + Math.sin(ang) * off;
    this.el.style.setProperty('--kx', `${kx}px`);
    this.el.style.setProperty('--ky', `${ky}px`);
  }

  /** 返回 {x, z}，长度 0..1；z 负值 = 屏幕向上 = 世界 -Z */
  vector() {
    if (this.activeId === null) return { x: 0, z: 0, active: false };
    const len = Math.hypot(this.dx, this.dy);
    if (len <= DEAD_ZONE) return { x: 0, z: 0, active: false };
    const mag = Math.min(1, (len - DEAD_ZONE) / (STICK_RADIUS - DEAD_ZONE));
    return {
      x: (this.dx / len) * mag,
      // 屏幕 y 轴向下为正，而 vector() 的 z 约定是「向上为正」
      // （与键盘 up => z=+1 保持同一套语义）。
      // 这里必须取负，否则手指上拖得到 z<0，经 main.js 的 dz=-mv.z
      // 二次取负后变成后退 —— 上下方向被完全抵消（实测：上拖往后走）。
      z: (-this.dy / len) * mag,
      active: true
    };
  }

  dispose() {
    this.el.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
    window.removeEventListener('pointercancel', this._onUp);
  }
}

export function createInput(target = window) {
  const state = { up: false, down: false, left: false, right: false };

  const down = (e) => {
    const k = KEY_MAP[e.code];
    if (k) { state[k] = true; e.preventDefault(); }
  };
  const up = (e) => {
    const k = KEY_MAP[e.code];
    if (k) { state[k] = false; e.preventDefault(); }
  };

  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);

  // 失焦时清空，避免"按键卡住"
  const clear = () => { state.up = state.down = state.left = state.right = false; };
  target.addEventListener('blur', clear);

  // 摇杆挂在一个覆盖全屏、但不吃事件的层上：只有它自己的 pointerdown 生效，
  // 其余区域的点击穿透到 canvas（避免挡住 HUD 之外的任何交互）。
  let stick = null;
  const stickEl = document.getElementById('stick');
  if (stickEl) stick = new TouchStick(stickEl);

  return {
    state,
    /** 返回 {x, z} 归一化到长度<=1 的移动向量（x=右, z=前） */
    vector() {
      let x = (state.right ? 1 : 0) - (state.left ? 1 : 0);
      let z = (state.up ? 1 : 0) - (state.down ? 1 : 0);
      let len = Math.hypot(x, z);
      if (len > 1) { x /= len; z /= len; len = 1; }

      if (stick) {
        const t = stick.vector();
        if (t.active) return { x: t.x, z: t.z, active: true };
      }
      return { x, z, active: len > 0 };
    },
    dispose() {
      target.removeEventListener('keydown', down);
      target.removeEventListener('keyup', up);
      target.removeEventListener('blur', clear);
      stick?.dispose();
    }
  };
}
