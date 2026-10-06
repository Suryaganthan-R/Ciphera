import React, { useContext } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowRight,
  Radar,
  Zap,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import heroImage from '../../../pic.png';
import AuthContext from '../context/AuthContext';
import { useSiteConfig } from '../context/SiteConfigContext';

const heroMetrics = [
  { value: '250+', label: 'attack paths' },
  { value: '24/7', label: 'live arena' },
  { value: 'Squads', label: 'team operations' },
];

export default function Home() {
  const navigate = useNavigate();
  const { isAuthenticated } = useContext(
    AuthContext as React.Context<{ isAuthenticated: boolean }>
  );
  const { eventName } = useSiteConfig();
  const platformName = eventName || 'Clover CTF';

  const handleStart = () => {
    if (isAuthenticated) {
      navigate('/challenges');
    } else {
      navigate('/register');
    }
  };

  const handleExplore = () => {
    if (isAuthenticated) {
      navigate('/scoreboard');
    } else {
      navigate('/event-status');
    }
  };

  return (
    <div className="relative isolate min-h-screen w-full overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(53,107,63,0.36)_0%,rgba(32,63,41,0.2)_38%,rgba(0,0,0,0.9)_100%)]" />
      <div className="pointer-events-none absolute left-[8%] top-[10%] h-56 w-56 rounded-full bg-[#356b3f]/40 blur-3xl" />
      <div className="pointer-events-none absolute left-1/2 top-[-10%] h-[26rem] w-[26rem] -translate-x-1/2 rounded-full bg-[#528a43]/18 blur-3xl" />
      <div className="pointer-events-none absolute bottom-[12%] right-[8%] h-72 w-72 rounded-full bg-[#203f29]/35 blur-3xl" />

      <section className="relative z-10 flex min-h-[calc(100vh-5.5rem)] w-full items-start justify-center pt-[3.55rem] sm:pt-[3.95rem]">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-6 py-2 sm:px-8 sm:py-4 lg:grid-cols-[1fr_1fr] lg:items-start lg:px-12 lg:py-4">
          <motion.div
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
            className="flex flex-col justify-start space-y-5 py-0 lg:pt-1"
          >
            <div className="inline-flex w-fit items-center gap-3 rounded-full border border-[#314d31] bg-[#172b1e]/60 py-2 pl-2 pr-5 text-xs font-semibold uppercase tracking-[0.28em] text-[#c9d9b2] backdrop-blur-xl">
              <div className="h-10 w-10 overflow-hidden rounded-full border border-[#4f9b50]/30">
                <img
                  src={heroImage}
                  alt="Clover CTF emblem"
                  className="h-full w-full object-cover"
                />
              </div>
              Clover Kingdom // 0x11
            </div>

            <h1
              className="mt-3 font-black leading-[0.9] tracking-[-0.04em]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              <span className="block bg-[linear-gradient(180deg,#FFFFFF_0%,#FBFBFF_54%,#E8E8F4_100%)] bg-clip-text text-5xl text-transparent sm:text-6xl md:text-7xl lg:text-[5.5rem]">
                {platformName}
              </span>
              <span className="mt-2 block bg-[linear-gradient(180deg,#F9FAFB_0%,#c9d9b2_58%,#4f9b50_100%)] bg-clip-text text-3xl text-transparent sm:text-4xl md:text-5xl lg:text-[3.5rem]">
                Magic Knight Trials
              </span>
            </h1>

            <p className="mt-4 max-w-lg text-base leading-7 text-[#c9d9b2] sm:text-lg sm:leading-8">
              Train. Exploit. Defend. A premium platform for team collaboration and focused practice.
            </p>

            <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:flex-wrap">
              <button
                onClick={handleStart}
                className="inline-flex items-center justify-center gap-3 rounded-2xl bg-[#4f9b50] px-7 py-4 text-sm font-semibold text-[#F9FAFB] shadow-[0_18px_40px_rgba(79,155,80,0.28)] transition-transform duration-200 hover:-translate-y-0.5 hover:bg-[#367c3d]"
              >
                <Zap className="h-5 w-5" />
                Start Challenges
                <ArrowRight className="h-5 w-5" />
              </button>

              <button
                onClick={handleExplore}
                className="inline-flex items-center justify-center gap-3 rounded-2xl border border-[#314d31] bg-[#000000]/40 px-7 py-4 text-sm font-semibold text-[#F9FAFB] backdrop-blur-xl transition-colors duration-200 hover:bg-[#172b1e]/70"
              >
                <Radar className="h-5 w-5 text-[#c9d9b2]" />
                Scoreboard
              </button>
            </div>

            <div className="mt-5 flex flex-wrap gap-3 text-xs font-semibold uppercase tracking-[0.24em] text-[#c9d9b2] sm:text-sm">
              {['Live scoring', 'Exploit rehearsal'].map((item) => (
                <span
                  key={item}
                  className="rounded-full border border-[#314d31] bg-[#314d31]/35 px-4 py-2"
                >
                  {item}
                </span>
              ))}
            </div>

            <div className="mt-7 flex flex-wrap gap-3">
              {heroMetrics.map((metric) => (
                <div
                  key={metric.label}
                  className="w-[112px] rounded-[0.95rem] border border-[#314d31] bg-[#172b1e]/45 px-3 py-2.5 backdrop-blur-xl sm:w-[120px]"
                >
                  <div className="text-[1.55rem] font-bold leading-none text-[#F9FAFB] sm:text-[1.65rem]">{metric.value}</div>
                  <div className="mt-1 text-[9px] uppercase tracking-[0.14em] text-[#c9d9b2] sm:text-[10px]">{metric.label}</div>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 36 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.72, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
            className="relative flex items-start justify-center lg:translate-x-12 lg:max-w-[450px]"
          >
            <div className="absolute inset-x-8 top-1/2 h-64 w-full -translate-y-12 rounded-full bg-[#4f9b50]/30 blur-3xl" />
            <div className="relative w-full max-w-[480px]">
              <motion.div
                aria-hidden="true"
                className="pointer-events-none absolute -inset-3 rounded-[58px] border border-[#79b856]/70"
                animate={{
                  opacity: [0.45, 1, 0.55],
                  scale: [1, 1.015, 1],
                  boxShadow: [
                    '0 0 14px rgba(79,155,80,0.18), 0 0 28px rgba(215,184,75,0.08)',
                    '0 0 22px rgba(79,155,80,0.48), 0 0 42px rgba(215,184,75,0.24)',
                    '0 0 14px rgba(79,155,80,0.18), 0 0 28px rgba(215,184,75,0.08)',
                  ],
                }}
                transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <div className="relative aspect-[4/5] w-full max-w-[480px] overflow-hidden rounded-[50px] border border-[#314d31] bg-[linear-gradient(180deg,rgba(8,18,10,0.72)_0%,rgba(4,9,5,0.38)_100%)] p-3 shadow-[0_24px_80px_rgba(53,107,63,0.6)] backdrop-blur-xl lg:h-auto lg:aspect-auto">
                <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(79,155,80,0.08)_0%,rgba(0,0,0,0)_55%)]" />
                <img
                  src={heroImage}
                  alt="Clover CTF arena artwork"
                  className="h-full w-full rounded-[40px] object-cover"
                />
              </div>
            </div>
          </motion.div>
        </div>
      </section>
    </div>
  );
}
