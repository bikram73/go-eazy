import { useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { supabase } from '../lib/supabase'
import { setUser, setProfile, logout, setLoading } from '../store/authSlice'

export const useAuth = () => {
  const dispatch = useDispatch()
  const { user, profile, role, loading, authModalOpen, authModalTab } = useSelector(s => s.auth)

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(({ data: { session }, error }) => {

      if (error) console.error('Auth: Session error', error)
      
      dispatch(setUser(session?.user ?? null))
      if (session?.user) fetchProfile(session.user.id)
      else dispatch(setLoading(false))
    })

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {

      
      dispatch(setUser(session?.user ?? null))
      if (session?.user) {
        fetchProfile(session.user.id)
      } else if (event === 'SIGNED_OUT') {
        dispatch(logout())
      } else {
        dispatch(setLoading(false))
      }
    })

    return () => subscription.unsubscribe()
  }, [])

  const fetchProfile = async (userId) => {
    try {
      // First try to fetch
      let { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle()
      
      // If no profile exists (e.g., first-time OAuth), create one automatically
      if (!data && !error) {

        const { data: { user }, error: userError } = await supabase.auth.getUser()

        // ── GHOST SESSION GUARD ──
        // If the user no longer exists in Supabase (deleted from dashboard),
        // their JWT is orphaned. Force sign them out immediately.
        if (userError || !user) {
          console.warn('Auth: Ghost session detected — user deleted. Forcing sign-out.')
          await supabase.auth.signOut()
          dispatch(logout())
          return
        }

        const fullName = user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'
        const userRole = user?.user_metadata?.role || null
        
        const { data: newProfile, error: upsertError } = await supabase
          .from('profiles')
          .upsert({
            id: userId,
            email: user?.email,
            full_name: fullName,
            role: userRole,
            avatar_url: user?.user_metadata?.avatar_url || `https://api.dicebear.com/7.x/avataaars/svg?seed=${fullName}`,
            created_at: new Date().toISOString()
          })
          .select()
          .maybeSingle()

        if (upsertError) {
          // ── FK CONSTRAINT GUARD ──
          // code 23503 = foreign key violation (user deleted from auth.users)
          // status 403/401 = JWT is now invalid
          const isGhostUser = upsertError.code === '23503' || upsertError.status === 403 || upsertError.status === 401
          if (isGhostUser) {
            console.warn('Auth: Deleted account confirmed via FK/auth error. Forcing sign-out.')
            await supabase.auth.signOut()
            dispatch(logout())
            return
          }
          console.error('Auth: Profile creation failed', upsertError)
          throw upsertError
        }
        data = newProfile
      } else if (error) {
        // ── FETCH ERROR GUARD ──
        // 403/401 on profile fetch = stale/invalid token (user deleted)
        const isAuthError = error.status === 403 || error.status === 401
        if (isAuthError) {
          console.warn('Auth: Invalid token on profile fetch. Forcing sign-out.')
          await supabase.auth.signOut()
          dispatch(logout())
          return
        }
        console.error('Auth: Profile fetch error', error)
        throw error
      }


      dispatch(setProfile(data))
    } catch (err) {
      console.error('Auth: fetchProfile catch block', err)
      dispatch(setLoading(false))
    }
  }

  const signUp = async ({ email, password, name, role }) => {
    try {
      // First check if user already exists
      const { data: existingUser } = await supabase.auth.getUser()
      
      // Check if email is already registered by attempting to get user info
      const { data: signInAttempt, error: signInError } = await supabase.auth.signInWithPassword({
        email,
        password: 'dummy-password-check'
      })
      
      // If no error on email (but wrong password), user exists
      if (signInError && signInError.message.includes('Invalid login credentials')) {
        throw new Error('An account with this email already exists. Please log in instead.')
      }
      
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { 
          data: { 
            full_name: name,
            role: role 
          },
          emailRedirectTo: `${window.location.origin}/auth-callback`
        },
      })
      
      if (error) {
        if (error.message.includes('User already registered')) {
          throw new Error('An account with this email already exists. Please log in instead.')
        }
        throw error
      }

      if (data.user && !data.user.email_confirmed_at) {
        // User needs to verify email
        await supabase.from('profiles').upsert({
          id: data.user.id,
          email,
          full_name: name,
          role,
          avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${name}`,
          created_at: new Date().toISOString(),
        })
      }
      
      return data
    } catch (error) {
      throw error
    }
  }

  const signIn = async ({ email, password }) => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password })
      
      if (error) {
        if (error.message.includes('Invalid login credentials') || error.message.includes('Email not confirmed')) {
          // Check if user exists but email not verified
          const { data: userData, error: userError } = await supabase.auth.signUp({
            email,
            password: 'dummy-check',
            options: { emailRedirectTo: `${window.location.origin}/auth-callback` }
          })
          
          if (userError && userError.message.includes('User already registered')) {
            throw new Error('Please verify your email before logging in.')
          } else if (userError && userError.message.includes('Invalid login credentials')) {
            throw new Error('No account found with this email. Please sign up first.')
          }
        }
        throw error
      }
      
      // Check if email is verified
      if (data.user && !data.user.email_confirmed_at) {
        await supabase.auth.signOut()
        throw new Error('Please verify your email before logging in.')
      }
      
      return data
    } catch (error) {
      throw error
    }
  }

  const signInWithGoogle = async () => {
    // Priority: Saved return path > Env variable > current origin
    const savedPath = localStorage.getItem('sb_return_to')
    const redirectUrl = savedPath 
      ? `${window.location.origin}${savedPath}`
      : (import.meta.env.VITE_REDIRECT_URL || `${window.location.origin}/search`)
    
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { 
        redirectTo: redirectUrl,
        queryParams: {
          prompt: 'select_account'
        }
      },
    })
    if (error) throw error
  }

  const signOut = async () => {
    await supabase.auth.signOut()
    dispatch(logout())
  }

  const resetPassword = async (email) => {
    const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`
    })
    if (error) throw error
    return data
  }

  const updatePassword = async (newPassword) => {
    const { data, error } = await supabase.auth.updateUser({
      password: newPassword
    })
    if (error) throw error
    return data
  }

  const resendVerification = async (email) => {
    const { data, error } = await supabase.auth.resend({
      type: 'signup',
      email: email,
      options: {
        emailRedirectTo: `${window.location.origin}/auth-callback`
      }
    })
    if (error) throw error
    return data
  }

  const updateProfile = async (updates) => {
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', user.id)
      .select()
      .maybeSingle()
    if (error) throw error
    dispatch(setProfile(data))
    return data
  }

  return { 
    user, 
    profile, 
    role, 
    loading, 
    authModalOpen, 
    authModalTab, 
    signUp, 
    signIn, 
    signInWithGoogle, 
    signOut, 
    resetPassword, 
    updatePassword, 
    resendVerification, 
    updateProfile 
  }
}
