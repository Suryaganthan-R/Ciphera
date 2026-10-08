import { useEffect, useState } from 'react';
import axios from 'axios';
import { AlertTriangle, Clipboard, Flag } from 'lucide-react';
import './FlagAdmin.css';

function FlagAdmin() {
  const [flagList, setFlagList] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;

    axios.get('/api/flag-admin')
      .then(({ data }) => {
        if (active) setFlagList(data);
      })
      .catch(() => {
        if (active) setError('Could not load challenge flags.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const copyFlags = async () => {
    try {
      await navigator.clipboard.writeText(flagList);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setError('Clipboard access is unavailable in this browser.');
    }
  };

  const flagCount = flagList ? flagList.split('\n').length : 0;

  return (
    <section className="flag-admin" aria-labelledby="flag-admin-title">
      <header className="flag-admin__header">
        <div>
          <p className="flag-admin__eyebrow">ADMIN TOOL</p>
          <h1 id="flag-admin-title"><Flag size={22} aria-hidden="true" /> Challenge flags</h1>
          <p className="flag-admin__count">{loading ? 'Loading flags…' : `${flagCount} challenges`}</p>
        </div>
        <button
          className="flag-admin__copy"
          type="button"
          onClick={copyFlags}
          disabled={loading || !flagList}
          title="Copy all challenge flags"
        >
          <Clipboard size={16} aria-hidden="true" />
          {copied ? 'Copied' : 'Copy all'}
        </button>
      </header>

      {error && <p className="flag-admin__error"><AlertTriangle size={16} />{error}</p>}
      {!loading && !error && (flagList
        ? <pre className="flag-admin__list">{flagList}</pre>
        : <p className="flag-admin__empty">No challenges found.</p>)}
    </section>
  );
}

export default FlagAdmin;