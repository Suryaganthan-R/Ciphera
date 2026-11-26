import { useState, useContext, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import AuthContext from '../context/AuthContext';
import { useSiteConfig } from '../context/SiteConfigContext';
import './AdminCreateUser.css';

function AdminCreateUser() {
  const { isAuthenticated, user } = useContext(AuthContext);
  const { visibility, updateVisibility } = useSiteConfig();
  const navigate = useNavigate();

  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    type: 'user',
    verified: false,
    hidden: false,
    banned: false
  });

  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUpdatingRegistration, setIsUpdatingRegistration] = useState(false);
  const [registrationMessage, setRegistrationMessage] = useState('');

  useEffect(() => {
    if (!isAuthenticated) {
      navigate('/login');
    } else if (user && user.role !== 'admin') {
      navigate('/');
    }
  }, [isAuthenticated, user, navigate]);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData({
      ...formData,
      [name]: value
    });
    setError('');
  };

  const handleCheckboxChange = (e) => {
    const { name, checked } = e.target;
    setFormData(prev => ({ ...prev, [name]: checked }));
    setError('');
  };

  const handleRegistrationToggle = async (e) => {
    setIsUpdatingRegistration(true);
    setRegistrationMessage('');
    const result = await updateVisibility({
      ...visibility,
      registration: e.target.checked ? 'public' : 'private'
    });
    setIsUpdatingRegistration(false);
    setRegistrationMessage(result.success
      ? `Public registration ${e.target.checked ? 'enabled' : 'disabled'}.`
      : result.message || 'Failed to update registration setting.');
  };

  const validateForm = () => {
    if (!formData.username || !formData.email || !formData.password || !formData.confirmPassword) {
      setError('All fields are required');
      return false;
    }

    if (formData.username.length < 3) {
      setError('Username must be at least 3 characters');
      return false;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(formData.email)) {
      setError('Please enter a valid email address');
      return false;
    }

    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters');
      return false;
    }

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return false;
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    setIsSubmitting(true);
    setError('');

    try {
      const res = await axios.post(
        '/api/auth/register-admin',
        {
          username: formData.username,
          email: formData.email,
          password: formData.password,
          type: formData.type,
          verified: formData.verified,
          hidden: formData.hidden,
          banned: formData.banned
        }
      );

      setSuccessMessage('User created successfully!');
      setFormData({
        username: '',
        email: '',
        password: '',
        confirmPassword: '',
        type: 'user',
        verified: false,
        hidden: false,
        banned: false
      });

      setTimeout(() => {
        navigate('/admin');
      }, 2000);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to create user');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="admin-create-user">
      <div className="create-user-container">
        <div className="create-user-header">
          <h1>Create New <span className="highlight">User</span></h1>
          <p>Add a new user to the platform</p>
        </div>

        <section className="registration-setting" aria-labelledby="registration-setting-title">
          <div>
            <h2 id="registration-setting-title">Public Registration</h2>
            <p>Allow new users to create accounts with Google sign-in.</p>
          </div>
          <label className="registration-setting-toggle">
            <input
              type="checkbox"
              checked={visibility.registration === 'public'}
              onChange={handleRegistrationToggle}
              disabled={isUpdatingRegistration}
            />
            <span>{isUpdatingRegistration ? 'Saving...' : visibility.registration === 'public' ? 'Enabled' : 'Disabled'}</span>
          </label>
          {registrationMessage && (
            <p className="registration-setting-message" role="status">{registrationMessage}</p>
          )}
        </section>

        {error && <div className="error-message">{error}</div>}
        {successMessage && <div className="success-message">{successMessage}</div>}

        <form onSubmit={handleSubmit} className="create-user-form">
          <div className="form-group">
            <label htmlFor="username">Username</label>
            <input
              type="text"
              id="username"
              name="username"
              value={formData.username}
              onChange={handleChange}
              placeholder="Enter username (min 3 characters)"
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="email">Email</label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              placeholder="Enter email address"
              autoComplete="off"
              required
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                type="password"
                id="password"
                name="password"
                value={formData.password}
                onChange={handleChange}
                placeholder="Enter password (min 6 characters)"
                autoComplete="new-password"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="confirmPassword">Confirm Password</label>
              <input
                type="password"
                id="confirmPassword"
                name="confirmPassword"
                value={formData.confirmPassword}
                onChange={handleChange}
                placeholder="Confirm password"
                autoComplete="new-password"
                required
              />
            </div>
          </div>

          <div className="form-row type-row">
            <div className="form-group type-group">
              <label htmlFor="type">Type</label>
              <select id="type" name="type" value={formData.type} onChange={handleChange}>
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>

          <div className="form-row checkbox-row">
            <div className="form-group">
              <label>
                <input type="checkbox" name="verified" checked={formData.verified} onChange={handleCheckboxChange} /> Verified
              </label>
            </div>
            <div className="form-group">
              <label>
                <input type="checkbox" name="hidden" checked={formData.hidden} onChange={handleCheckboxChange} /> Hidden
              </label>
            </div>
            <div className="form-group">
              <label>
                <input type="checkbox" name="banned" checked={formData.banned} onChange={handleCheckboxChange} /> Banned
              </label>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => navigate('/admin')}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={isSubmitting}
            >
              {isSubmitting ? 'Creating...' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default AdminCreateUser;
