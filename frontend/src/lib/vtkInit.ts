/**
 * VTK.js volume-rendering helpers.
 *
 * We create a render window that is bound to a caller-supplied container div
 * rather than taking over the full browser window.
 */

import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkRenderer from '@kitware/vtk.js/Rendering/Core/Renderer';
import vtkRenderWindow from '@kitware/vtk.js/Rendering/Core/RenderWindow';
import vtkRenderWindowInteractor from '@kitware/vtk.js/Rendering/Core/RenderWindowInteractor';
import vtkInteractorStyleTrackballCamera from '@kitware/vtk.js/Interaction/Style/InteractorStyleTrackballCamera';

export interface VtkContext {
  fullScreenRenderWindow: ReturnType<typeof vtkFullScreenRenderWindow.newInstance>;
  renderWindow: vtkRenderWindow;
  renderer: vtkRenderer;
  interactor: vtkRenderWindowInteractor;
}

/**
 * Create a VTK.js render window bound to *container*.
 *
 * The container div must already be in the DOM and have a non-zero size before
 * this function is called (typically called inside a React useEffect with the
 * ref element as dependency).
 */
export function createVolumeRenderer(container: HTMLDivElement): VtkContext {
  const fullScreenRenderWindow = vtkFullScreenRenderWindow.newInstance({
    container,
    background: [0.1, 0.1, 0.1],
  });

  const renderWindow = fullScreenRenderWindow.getRenderWindow() as vtkRenderWindow;
  const renderer = fullScreenRenderWindow.getRenderer() as vtkRenderer;
  const interactor = fullScreenRenderWindow.getInteractor() as vtkRenderWindowInteractor;

  const interactorStyle = vtkInteractorStyleTrackballCamera.newInstance();
  interactor.setInteractorStyle(interactorStyle);

  // Wrap VTK's resize method so its internal window-resize handler can't crash
  // when the OpenGL renderer isn't fully initialised yet (container starts as
  // display:none, so WebGL setup is deferred). VTK publicAPI is frozen so we
  // must use Object.defineProperty instead of direct assignment.
  const fsrw = fullScreenRenderWindow as any;
  if (typeof fsrw.resize === 'function') {
    const _origResize = fsrw.resize.bind(fsrw);
    try {
      Object.defineProperty(fsrw, 'resize', {
        writable: true,
        configurable: true,
        value: (...args: unknown[]) => {
          try {
            _origResize(...args);
          } catch {
            // renderer not ready — skip this resize tick
          }
        },
      });
    } catch {
      // defineProperty also failed — live without the guard
    }
  }

  return { fullScreenRenderWindow, renderWindow, renderer, interactor };
}

/**
 * Resize the VTK render window to match its container element.
 * Call this from a ResizeObserver or after layout changes.
 */
export function resizeVtkRenderer(ctx: VtkContext): void {
  const { fullScreenRenderWindow, renderer } = ctx;
  // Guard: only resize when at least one actor/volume is present
  if (renderer.getActors().length === 0 && renderer.getVolumes().length === 0) return;
  if (typeof (fullScreenRenderWindow as any).resize === 'function') {
    try {
      (fullScreenRenderWindow as any).resize();
    } catch {
      // ignore resize errors during teardown
    }
  }
}
