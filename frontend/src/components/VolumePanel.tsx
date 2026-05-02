/**
 * VolumePanel — 3-D Maximum Intensity Projection rendered with VTK.js.
 *
 * The component fetches the full volume as a JSON+base64 payload from
 * GET /volumes/{uid}/volume, constructs a vtkImageData directly (no NRRD
 * reader required), then sets up a vtkVolumeMapper in MaximumIntensity mode.
 */

import React, { useEffect, useRef } from 'react';
import { getVolumeJSON } from '../api/client';
import type { StudyMeta } from '../api/types';
import { createVolumeRenderer, resizeVtkRenderer, type VtkContext } from '../lib/vtkInit';

// VTK.js imports
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';

function b64ToFloat32(b64: string): Float32Array {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Float32Array(buf.buffer);
}

interface Props {
  study: StudyMeta | null;
  overrideUid?: string | null;
}

const VolumePanel: React.FC<Props> = ({ study, overrideUid }) => {
  const uid = overrideUid ?? study?.uid ?? null;
  const containerRef = useRef<HTMLDivElement>(null);
  const vtkCtxRef = useRef<VtkContext | null>(null);
  const volumeActorRef = useRef<ReturnType<typeof vtkVolume.newInstance> | null>(null);

  // Initialise VTK render window once
  useEffect(() => {
    if (!containerRef.current) return;

    const ctx = createVolumeRenderer(containerRef.current);
    vtkCtxRef.current = ctx;

    const ro = new ResizeObserver(() => {
      if (vtkCtxRef.current) resizeVtkRenderer(vtkCtxRef.current);
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      if (volumeActorRef.current && vtkCtxRef.current) {
        vtkCtxRef.current.renderer.removeVolume(volumeActorRef.current);
        volumeActorRef.current = null;
      }
      if (vtkCtxRef.current) {
        vtkCtxRef.current.renderWindow.delete();
        vtkCtxRef.current = null;
      }
    };
  }, []);

  // Load volume and build MIP pipeline whenever the active uid changes
  useEffect(() => {
    if (!uid || !vtkCtxRef.current) return;

    const ctx = vtkCtxRef.current;
    const { renderer, renderWindow } = ctx;

    if (volumeActorRef.current) {
      renderer.removeVolume(volumeActorRef.current);
      volumeActorRef.current = null;
    }

    getVolumeJSON(uid)
      .then(({ shape, spacing, origin, data_b64 }) => {
        const [nz, ny, nx] = shape;
        const [dz, dy, dx] = spacing;
        const [oz, oy, ox] = origin;

        const floatData = b64ToFloat32(data_b64);

        // Build vtkImageData: VTK uses (x,y,z) convention with fastest-varying x
        const imageData = vtkImageData.newInstance();
        imageData.setDimensions(nx, ny, nz);
        imageData.setSpacing([dx, dy, dz]);
        imageData.setOrigin([ox, oy, oz] as [number, number, number]);

        const scalars = vtkDataArray.newInstance({
          name: 'HU',
          values: floatData,
          numberOfComponents: 1,
        });
        imageData.getPointData().setScalars(scalars);

        // Volume mapper in MIP mode
        const mapper = vtkVolumeMapper.newInstance();
        mapper.setInputData(imageData);
        mapper.setBlendModeToMaximumIntensity();
        mapper.setSampleDistance(1.0);

        // Opacity: transparent below 100 HU, opaque above 300 HU
        const ofun = vtkPiecewiseFunction.newInstance();
        ofun.addPoint(-1024, 0.0);
        ofun.addPoint(99, 0.0);
        ofun.addPoint(100, 0.1);
        ofun.addPoint(300, 0.9);
        ofun.addPoint(3071, 1.0);

        // Colour: greyscale
        const cfun = vtkColorTransferFunction.newInstance();
        cfun.addRGBPoint(-1024, 0, 0, 0);
        cfun.addRGBPoint(0, 0.15, 0.15, 0.15);
        cfun.addRGBPoint(300, 0.8, 0.8, 0.8);
        cfun.addRGBPoint(3071, 1, 1, 1);

        const volume = vtkVolume.newInstance();
        volume.setMapper(mapper);
        volume.getProperty().setRGBTransferFunction(0, cfun);
        volume.getProperty().setScalarOpacity(0, ofun);
        volume.getProperty().setInterpolationTypeToLinear();
        volume.getProperty().setShade(false);

        renderer.addVolume(volume);
        volumeActorRef.current = volume;

        // Resize first so the canvas matches the now-visible container,
        // then render. Retry once via rAF in case the first render fires
        // before the OpenGL context is fully ready.
        // Match the axial MPR's radiological convention:
        //  - viewUp = -Y so head is at top of canvas (anterior up)
        //  - 180° azimuth so patient's left appears on viewer's right
        const orientCamera = (): void => {
          const r = vtkCtxRef.current?.renderer;
          const cam = r?.getActiveCamera();
          if (!r || !cam) return;
          cam.setViewUp(0, -1, 0);
          cam.azimuth(180);
          r.resetCameraClippingRange();
        };

        resizeVtkRenderer(ctx);
        try {
          renderer.resetCamera();
          orientCamera();
          renderWindow.render();
        } catch {
          requestAnimationFrame(() => {
            if (!vtkCtxRef.current) return;
            try {
              vtkCtxRef.current.renderer.resetCamera();
              orientCamera();
              vtkCtxRef.current.renderWindow.render();
            } catch { /* give up */ }
          });
        }
      })
      .catch((err: unknown) => {
        console.error('VolumePanel: failed to load volume', err);
      });
  }, [uid]);

  return (
    <div className="panel panel-mip" style={{ height: '100%' }}>
      <span className="panel-label">3D MIP</span>
      {!uid && (
        <div className="panel-placeholder">No study loaded</div>
      )}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          display: uid ? 'block' : 'none',
        }}
      />
    </div>
  );
};

export default VolumePanel;
