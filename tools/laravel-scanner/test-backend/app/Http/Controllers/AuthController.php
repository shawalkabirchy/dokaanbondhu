<?php

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;

class AuthController extends Controller
{
    /** The login page: here only its XSRF-TOKEN cookie matters. */
    public function show()
    {
        return response()->json(['message' => 'Send your email and password to sign in.']);
    }

    public function login(Request $request)
    {
        $credentials = $request->validate([
            'email' => ['required', 'email'],
            'password' => ['required', 'string'],
        ]);
        if (! Auth::attempt($credentials)) {
            return response()->json(['message' => 'These credentials do not match our records.'], 422);
        }
        $request->session()->regenerate();

        return response()->json(['signed_in' => true]);
    }
}
