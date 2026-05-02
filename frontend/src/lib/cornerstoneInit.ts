import * as cornerstone from '@cornerstonejs/core';
import * as cornerstoneTools from '@cornerstonejs/tools';

const {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  LengthTool,
  AngleTool,
  StackScrollTool,
  CrosshairsTool,
} = cornerstoneTools;

/**
 * Initialise Cornerstone3D core and tools.
 *
 * Must be called once (and awaited) before any viewport is created or any
 * image loader is registered.
 */
export async function initCornerstone(): Promise<void> {
  await cornerstone.init();
  cornerstoneTools.init();

  // Register all tools globally so ToolGroups can activate them
  cornerstoneTools.addTool(WindowLevelTool);
  cornerstoneTools.addTool(PanTool);
  cornerstoneTools.addTool(ZoomTool);
  cornerstoneTools.addTool(LengthTool);
  cornerstoneTools.addTool(AngleTool);
  cornerstoneTools.addTool(StackScrollTool);
  cornerstoneTools.addTool(CrosshairsTool);
}
