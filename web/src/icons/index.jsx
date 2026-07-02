import { memo } from 'react';

export const IconLink = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 4" />
    <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 1 0 7.07 7.07L13 20" />
  </svg>
));

export const IconSpark = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2l2.4 6.2L21 10l-6.6 1.8L12 18l-2.4-6.2L3 10l6.6-1.8L12 2z" />
  </svg>
));

export const IconList = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 6h12M8 12h12M8 18h12" />
    <path d="M4 6h.01M4 12h.01M4 18h.01" />
  </svg>
));

export const IconMoon = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3a7 7 0 0 0 11.5 11.5z" />
  </svg>
));

export const IconSun = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </svg>
));

export const IconHome = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 10.5L12 3l9 7.5" />
    <path d="M5 10v9h5v-5h4v5h5v-9" />
  </svg>
));

export const IconLogin = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
  </svg>
));

export const IconLogout = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h4" />
    <path d="M14 17l5-5-5-5" />
    <path d="M19 12H9" />
  </svg>
));

export const IconCheck = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 6L9 17l-5-5" />
  </svg>
));

export const IconSlash = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M5 5l14 14" />
  </svg>
));

export const IconCheckCircle = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    <path d="M16 8l-5.5 7L8 12.5" />
  </svg>
));

export const IconLoader = memo(() => (
  <svg className="icon icon-spin" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3a9 9 0 1 1-6.36 2.64" />
  </svg>
));

export const IconClose = memo(() => (
  <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18 6L6 18" />
    <path d="M6 6l12 12" />
  </svg>
));
