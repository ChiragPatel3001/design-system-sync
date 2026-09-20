/**
 * Not part of the design system's public API — used only by *.stories.tsx
 * docs descriptions to link back to the exact Figma node a story
 * implements, completing the Figma -> Manifest -> Code -> Storybook trail.
 *
 * Base URL taken verbatim from design-system-manifest.json ("source.url");
 * only the node-id query param changes per component (Figma's own deep-link
 * format: "15:664" -> "15-664").
 */
const FIGMA_FILE_URL =
  'https://www.figma.com/design/opq4Is8eZdXdu920YDUIs1/Design-System-2.0';

export function figmaNodeUrl(nodeId: string): string {
  return `${FIGMA_FILE_URL}?node-id=${nodeId.replace(':', '-')}`;
}
