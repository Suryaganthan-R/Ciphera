import { useState } from 'react';
import { GoogleLogin } from '@react-oauth/google';
import UsernamePrompt from './UsernamePrompt';

// onCredential(credential, username) signs in. For a first-time user it returns
// { needsUsername } and is called again with the chosen name.
function GoogleSignInButton({ onCredential, onError }) {
  const [newUser, setNewUser] = useState(null);

  if (!import.meta.env.VITE_GOOGLE_CLIENT_ID) return null;

  const width = Math.min(350, window.innerWidth - 80);

  const handleCredential = async (credential) => {
    const result = await onCredential(credential);
    if (result?.needsUsername) {
      setNewUser({ credential, suggestion: result.suggestedUsername });
    }
  };

  return (
    <div className="htb-google-signin">
      <div className="htb-google-signin-divider"><span>OR</span></div>
      <div className="htb-google-signin-button">
        <GoogleLogin
          onSuccess={(response) => {
            if (response.credential) handleCredential(response.credential);
            else onError?.('Google did not return a sign-in credential.');
          }}
          onError={() => onError?.('Google sign-in was cancelled or failed.')}
          text="continue_with"
          theme="outline"
          shape="rect"
          width={String(width)}
        />
      </div>
      {newUser && (
        <UsernamePrompt
          suggestion={newUser.suggestion}
          onSubmit={(username) => onCredential(newUser.credential, username)}
          onCancel={() => setNewUser(null)}
        />
      )}
    </div>
  );
}

export default GoogleSignInButton;
