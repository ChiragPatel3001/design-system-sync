/**
 * Placeholder icons for the demo app only (src/App.tsx) — NOT part of the
 * design system's public API and not exported from src/index.ts.
 *
 * The manifest explicitly notes that actual SVG icon paths could not be
 * captured from Figma ("coverage.notCaptured": "Actual SVG icon paths
 * (asset URLs from the tool are local and temporary)"). These generic
 * glyphs stand in for Favorite/Mail/Help circle/Arrow right-circle/Home/
 * Arrow up-right so the components can be demoed with icon slots filled;
 * they are not meant to be pixel-accurate reproductions of the Figma icons.
 */
import type { SVGProps } from 'react';

function IconBase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}

export function FavoriteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M10 17s-6.5-4.1-6.5-8.6C3.5 5.8 5.3 4 7.5 4c1.2 0 2.3.6 2.5 1.5C10.2 4.6 11.3 4 12.5 4c2.2 0 4 1.8 4 4.4C16.5 12.9 10 17 10 17z" />
    </IconBase>
  );
}

export function MailIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <rect x="3" y="5" width="14" height="10" rx="1.5" />
      <path d="M3.5 5.5 10 11l6.5-5.5" />
    </IconBase>
  );
}

export function HelpCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="M7.8 7.8c.3-1 1.2-1.6 2.2-1.6 1.2 0 2.2.8 2.2 1.9 0 1.6-2.2 1.4-2.2 3.1" />
      <circle cx="10" cy="13.6" r="0.15" fill="currentColor" />
    </IconBase>
  );
}

export function ArrowRightCircleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="M8 7l3 3-3 3" />
    </IconBase>
  );
}

export function HomeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4 10.5 10 5l6 5.5" />
      <path d="M5.5 9.5V16h9V9.5" />
    </IconBase>
  );
}

export function ArrowUpRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M6 14 14 6" />
      <path d="M8 6h6v6" />
    </IconBase>
  );
}
