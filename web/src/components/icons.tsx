import React from 'react';

// One line-icon vocabulary for the whole product.
//
// Every glyph is drawn on the same 24-unit grid with the same 1.7 stroke and
// `currentColor`, so an icon inherits the colour of whatever it sits in — a rail
// item, a button, a muted caption — without a second variant existing. They are
// decorative beside their own label, so each is hidden from assistive technology;
// nothing here is the only way to read a control.

type P = { size?: number; className?: string };

const svg = (size: number, className: string | undefined, children: React.ReactNode) => (
  <svg
    width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}
    stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false"
  >
    {children}
  </svg>
);

/** The brand mark: a shield with a check inside it. Drawn solid-on-blue. */
export function ShieldMark({ size = 19 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l7 2.5v5.2c0 4.5-3 8.2-7 9.8-4-1.6-7-5.3-7-9.8V5.5L12 3z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9 11.6l2.1 2.1L15.3 9.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const IconQueue = ({ size = 18, className }: P) => svg(size, className, <>
  <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
  <path d="M3.5 9h17M8.5 4v16" />
</>);

export const IconCheckSquare = ({ size = 18, className }: P) => svg(size, className, <>
  <path d="M20.5 11.2V18a2.5 2.5 0 01-2.5 2.5H6A2.5 2.5 0 013.5 18V6A2.5 2.5 0 016 3.5h9" />
  <path d="M8.5 11.5l3 3 9-9.5" />
</>);

export const IconPeople = ({ size = 18, className }: P) => svg(size, className, <>
  <circle cx="9" cy="8" r="3.2" />
  <path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
  <path d="M16 5.2a3.2 3.2 0 010 5.8M17.5 14.8c2 .6 3.3 2.4 3.3 4.7" />
</>);

export const IconPerson = ({ size = 18, className }: P) => svg(size, className, <>
  <circle cx="12" cy="8" r="3.6" />
  <path d="M5 20c0-3.4 3-6 7-6s7 2.6 7 6" />
</>);

export const IconGrid = ({ size = 18, className }: P) => svg(size, className, <>
  <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
  <path d="M3.5 9.5h17M3.5 15h17" />
</>);

export const IconTarget = ({ size = 18, className }: P) => svg(size, className, <>
  <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
  <path d="M7.5 9h6M7.5 13h9M7.5 16h4" />
</>);

export const IconArrowUpRight = ({ size = 18, className }: P) => svg(size, className, <>
  <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
  <path d="M9.5 14.5l5-5M10.3 9.5h4.2v4.2" />
</>);

export const IconBook = ({ size = 18, className }: P) => svg(size, className, <>
  <path d="M4.5 5.2A1.7 1.7 0 016.2 3.5H19a1 1 0 011 1v13.2" />
  <path d="M4.5 5.2v13.3A2 2 0 006.5 20.5H20" />
  <path d="M8.5 8h7M8.5 11.5h5" />
</>);

export const IconTrash = ({ size = 18, className }: P) => svg(size, className, <>
  <path d="M4.5 6.5h15M9.5 6.5V4.8a1.3 1.3 0 011.3-1.3h2.4a1.3 1.3 0 011.3 1.3v1.7" />
  <path d="M6.5 6.5l.8 12a2 2 0 002 1.9h5.4a2 2 0 002-1.9l.8-12" />
</>);

export const IconChain = ({ size = 18, className }: P) => svg(size, className, <>
  <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
  <path d="M10.2 12.4l1.6-1.6a2.2 2.2 0 013.1 3.1l-.9.9" />
  <path d="M13.8 11.6l-1.6 1.6a2.2 2.2 0 01-3.1-3.1l.9-.9" />
</>);

export const IconDatabase = ({ size = 18, className }: P) => svg(size, className, <>
  <ellipse cx="12" cy="6" rx="7" ry="2.8" />
  <path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6" />
  <path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
</>);

export const IconUpload = ({ size = 26, className }: P) => svg(size, className, <>
  <path d="M12 16V4M8 8l4-4 4 4" />
  <path d="M4 16.5V18a2.5 2.5 0 002.5 2.5h11A2.5 2.5 0 0020 18v-1.5" />
</>);

export const IconCamera = ({ size = 26, className }: P) => svg(size, className, <>
  <path d="M4 8h3l1.4-2h7.2L17 8h3a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1V9a1 1 0 011-1z" />
  <circle cx="12" cy="13" r="3.4" />
</>);

export const IconImage = ({ size = 24, className }: P) => svg(size, className, <>
  <rect x="3" y="5" width="18" height="14" rx="2.5" />
  <circle cx="8.6" cy="10" r="1.4" />
  <path d="M3.5 16.5l4.6-4.3 3.6 3.4 3-2.7 5.8 5.2" />
</>);

export const IconDownload = ({ size = 17, className }: P) => svg(size, className, <>
  <path d="M12 3.5v11M8 11l4 4 4-4" />
  <path d="M4.5 17v1.5a2 2 0 002 2h11a2 2 0 002-2V17" />
</>);

export const IconDoc = ({ size = 20, className }: P) => svg(size, className, <>
  <path d="M13.5 3.5H7a2 2 0 00-2 2v13a2 2 0 002 2h10a2 2 0 002-2V9l-5.5-5.5z" />
  <path d="M13.5 3.5V9H19M8.5 13h7M8.5 16.5h4.5" />
</>);

export const IconGear = ({ size = 20, className }: P) => svg(size, className, <>
  <circle cx="12" cy="12" r="3" />
  <path d="M12 3v2.2M12 18.8V21M19.8 7.5l-1.9 1.1M6.1 15.4l-1.9 1.1M19.8 16.5l-1.9-1.1M6.1 8.6L4.2 7.5" />
</>);

export const IconPlus = ({ size = 16, className }: P) => svg(size, className, <path d="M12 5.5v13M5.5 12h13" />);

export const IconPencil = ({ size = 16, className }: P) => svg(size, className, <>
  <path d="M16.2 4.3l3.5 3.5M4 20l4.4-.9L19.6 7.9a1.7 1.7 0 000-2.4l-1.1-1.1a1.7 1.7 0 00-2.4 0L4.9 15.6 4 20z" />
</>);

export const IconArchive = ({ size = 16, className }: P) => svg(size, className, <>
  <rect x="3.5" y="4.5" width="17" height="4" rx="1.3" />
  <path d="M5 8.5V18a2 2 0 002 2h10a2 2 0 002-2V8.5M10 12.5h4" />
</>);

export const IconEye = ({ size = 16, className }: P) => svg(size, className, <>
  <path d="M2.8 12S6.5 5.8 12 5.8 21.2 12 21.2 12 17.5 18.2 12 18.2 2.8 12 2.8 12z" />
  <circle cx="12" cy="12" r="2.8" />
</>);

export const IconPause = ({ size = 16, className }: P) => svg(size, className, <path d="M9.5 5v14M14.5 5v14" />);

export const IconCalendar = ({ size = 20, className }: P) => svg(size, className, <>
  <rect x="3.5" y="5" width="17" height="15.5" rx="2.5" />
  <path d="M3.5 10h17M8.5 3v4M15.5 3v4" />
</>);

export const IconSignOut = ({ size = 17, className }: P) => svg(size, className, <>
  <path d="M10 20.5H6a2 2 0 01-2-2v-13a2 2 0 012-2h4" />
  <path d="M15.5 8l4 4-4 4M19.5 12H9.5" />
</>);

export const IconRefresh = ({ size = 17, className }: P) => svg(size, className, <>
  <path d="M20 11a8 8 0 10-.7 4.6" />
  <path d="M20.5 5v6h-6" />
</>);

export const IconArrowLeft = ({ size = 17, className }: P) => svg(size, className, <path d="M19 12H5.5M11 5.5L4.5 12l6.5 6.5" />);

export const IconClose = ({ size = 18, className }: P) => svg(size, className, <path d="M6 6l12 12M18 6L6 18" />);

export const IconCheck = ({ size = 16, className }: P) => svg(size, className, <path d="M4.5 12.5l5 5 10-11" />);

export const IconSuccessRing = ({ size = 18, className }: P) => svg(size, className, <>
  <circle cx="12" cy="12" r="8.6" />
  <path d="M8.5 12.3l2.4 2.4 4.8-5.2" />
</>);
