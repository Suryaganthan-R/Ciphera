import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { LiquidMetalButton } from './ui/liquid-metal-button';
import './PillNav.css';

function PillNav({
  logo,
  logoAlt = 'Brand logo',
  items = [],
  activeHref = '/',
  className = '',
  baseColor = '#000000',
  pillColor = '#ffffff',
  pillTextColor = '#000000',
  hoveredPillTextColor = '#ffffff',
  brandName = 'CloverCTF',
  brandAccent = '',
  mobileExtraContent,
}) {
  const fallbackLogo = '/logo.jpeg';
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [logoSource, setLogoSource] = useState(logo || fallbackLogo);
  const [logoLoadError, setLogoLoadError] = useState(false);

  useEffect(() => {
    setLogoSource(logo || fallbackLogo);
    setLogoLoadError(false);
  }, [logo]);

  const resolvedItems = useMemo(
    () => items.filter((item) => item && item.href && item.label),
    [items]
  );

  const brandParts = useMemo(() => {
    if (!brandAccent) {
      return { prefix: brandName, accent: '', suffix: '' };
    }

    const index = brandName.lastIndexOf(brandAccent);
    if (index === -1) {
      return { prefix: brandName, accent: '', suffix: '' };
    }

    return {
      prefix: brandName.slice(0, index),
      accent: brandName.slice(index, index + brandAccent.length),
      suffix: brandName.slice(index + brandAccent.length),
    };
  }, [brandAccent, brandName]);

  const navStyle = useMemo(
    () => ({
      '--pill-base': baseColor,
      '--pill-fill': pillColor,
      '--pill-text': pillTextColor,
      '--pill-hover-text': hoveredPillTextColor,
    }),
    [baseColor, hoveredPillTextColor, pillColor, pillTextColor]
  );

  useEffect(() => {
    setIsMobileMenuOpen(false);
  }, [activeHref]);

  const closeMobileMenu = () => {
    setIsMobileMenuOpen(false);
  };

  return (
    <div className={`pill-nav ${className}`.trim()} style={navStyle}>
      <Link to="/" className="pill-nav__brand" aria-label={brandName}>
        <div className="pill-nav__logo-shell">
          {!logoLoadError ? (
            <img
              src={logoSource}
              alt={logoAlt}
              className="pill-nav__logo"
              onError={() => {
                if (logoSource !== fallbackLogo) {
                  setLogoSource(fallbackLogo);
                } else {
                  setLogoLoadError(true);
                }
              }}
            />
          ) : (
            <span className="pill-nav__logo-fallback">{brandName.charAt(0)}</span>
          )}
        </div>
        <div className="pill-nav__brand-copy">
          <span className="pill-nav__brand-wordmark">
            {brandParts.prefix}
            {brandParts.accent ? <span className="pill-nav__brand-accent">{brandParts.accent}</span> : null}
            {brandParts.suffix}
          </span>
          <span className="pill-nav__brand-tag">Cyber Arena</span>
        </div>
      </Link>

      <div className="pill-nav__desktop">
        <div className="pill-nav__track">
          {resolvedItems.map((item) => (
            <LiquidMetalButton
              key={item.href}
              href={item.href}
              label={item.label}
              width={item.label.length * 7 + 28}
              active={activeHref === item.href}
            />
          ))}
        </div>
      </div>

      <button
        type="button"
        className="pill-nav__mobile-toggle"
        aria-expanded={isMobileMenuOpen}
        aria-label={isMobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
        onClick={() => setIsMobileMenuOpen((open) => !open)}
      >
        {isMobileMenuOpen ? <X size={20} /> : <Menu size={20} />}
      </button>

      {isMobileMenuOpen ? (
        <div className="pill-nav__mobile-panel">
          <div className="pill-nav__mobile-links">
            {resolvedItems.map((item) => (
              <Link
                key={item.href}
                to={item.href}
                className={`mobile-menu-link${activeHref === item.href ? ' is-active' : ''}`}
                onClick={closeMobileMenu}
              >
                {item.label}
              </Link>
            ))}
          </div>
          {mobileExtraContent ? mobileExtraContent({ closeMenu: closeMobileMenu }) : null}
        </div>
      ) : null}
    </div>
  );
}

export default PillNav;
