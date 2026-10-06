// Professional Cybersecurity Theme Configuration
// Inspired by Hack The Box and TryHackMe

export const theme = {
  colors: {
    // Background layers
    bg: {
      primary: '#070C08',
      secondary: '#0C140D',
      tertiary: '#111F14',
      elevated: '#18291A',
      hover: '#213A24',
    },
    
    // Primary accent (cyan/blue)
    primary: {
      50: '#edf5df',
      100: '#dcebc6',
      200: '#c9e2a9',
      300: '#b2d48b',
      400: '#91be65',
      500: '#4F9B50',
      600: '#367C3D',
      700: '#2D6935',
      800: '#24562D',
      900: '#1B4324',
    },
    
    // Success (green)
    success: {
      50: '#e6f9f0',
      100: '#b3efd4',
      200: '#80e5b8',
      300: '#4ddb9c',
      400: '#26d386',
      500: '#00cb70',
      600: '#00b866',
      700: '#00a159',
      800: '#008a4d',
      900: '#006637',
    },
    
    // Warning (orange)
    warning: {
      50: '#fff5e6',
      100: '#ffe4b3',
      200: '#ffd380',
      300: '#ffc24d',
      400: '#ffb526',
      500: '#D7B84B',
      600: '#C2A33B',
      700: '#A88B31',
      800: '#8E7428',
      900: '#705B1F',
    },
    
    // Danger (red)
    danger: {
      50: '#ffe6e6',
      100: '#ffb3b3',
      200: '#ff8080',
      300: '#ff4d4d',
      400: '#ff2626',
      500: '#ff0000',
      600: '#e60000',
      700: '#cc0000',
      800: '#b30000',
      900: '#8c0000',
    },
    
    // Info (clover leaf)
    info: {
      50: '#edf2dc',
      100: '#dbe9b9',
      200: '#c2db8e',
      300: '#a9c96b',
      400: '#8db650',
      500: '#72993d',
      600: '#5f7e33',
      700: '#4e692b',
      800: '#3d5424',
      900: '#2e411d',
    },
    
    // Text
    text: {
      primary: '#f2f5e8',
      secondary: '#cbd8c1',
      tertiary: '#9caf91',
      disabled: '#64755f',
      inverse: '#070C08',
    },
    
    // Borders
    border: {
      primary: '#314D31',
      secondary: '#111F14',
      focus: '#79B856',
      danger: '#ff0000',
      success: '#00cb70',
    },
    
    // Status
    status: {
      online: '#00cb70',
      offline: '#6b7280',
      away: '#ffa800',
      busy: '#ff0000',
    },
    
    // Difficulty colors
    difficulty: {
      easy: '#00cb70',
      medium: '#ffa800',
      hard: '#ff4d4d',
      insane: '#72993d',
    },
    
    // Special effects
    glow: {
      primary: 'rgba(79,155,80, 0.4)',
      success: 'rgba(0,203,112, 0.4)',
      danger: 'rgba(255,0,0, 0.4)',
      warning: 'rgba(255,168,0, 0.4)',
    },
  },
  
  fonts: {
    mono: '"JetBrains Mono", "Fira Code", "Consolas", "Monaco", monospace',
    sans: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Oxygen", "Ubuntu", sans-serif',
    heading: '"Space Grotesk", "Inter", sans-serif',
  },
  
  transitions: {
    fast: '150ms cubic-bezier(0.4, 0, 0.2, 1)',
    normal: '250ms cubic-bezier(0.4, 0, 0.2, 1)',
    slow: '350ms cubic-bezier(0.4, 0, 0.2, 1)',
  },
  
  shadows: {
    sm: '0 1px 2px 0 rgba(0,0,0, 0.3)',
    md: '0 4px 6px -1px rgba(0,0,0, 0.4)',
    lg: '0 10px 15px -3px rgba(0,0,0, 0.5)',
    xl: '0 20px 25px -5px rgba(0,0,0, 0.6)',
    glow: '0 0 20px rgba(79,155,80, 0.3)',
    glowSuccess: '0 0 20px rgba(0,203,112, 0.3)',
    glowDanger: '0 0 20px rgba(255,0,0, 0.3)',
  },
  
  borderRadius: {
    sm: '4px',
    md: '6px',
    lg: '8px',
    xl: '12px',
    full: '9999px',
  },
  
  spacing: {
    xs: '4px',
    sm: '8px',
    md: '16px',
    lg: '24px',
    xl: '32px',
    '2xl': '48px',
    '3xl': '64px',
  },
};

export default theme;
