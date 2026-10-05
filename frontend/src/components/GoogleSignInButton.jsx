import { GoogleLogin } from '@react-oauth/google';

function GoogleSignInButton({ onCredential, onError }) {
  if (!import.meta.env.VITE_GOOGLE_CLIENT_ID) return null;

  const width = Math.min(350, window.innerWidth - 80);

  return (
    <div className="htb-google-signin">
      <div className="htb-google-signin-divider"><span>OR</span></div>
      <div className="htb-google-signin-button">
        <GoogleLogin
          onSuccess={(response) => {
            if (response.credential) onCredential(response.credential);
            else onError?.('Google did not return a sign-in credential.');
          }}
          onError={() => onError?.('Google sign-in was cancelled or failed.')}
          text="continue_with"
          theme="outline"
          shape="rect"
          width={String(width)}
        />
      </div>
    </div>
  );
}

export default GoogleSignInButton;