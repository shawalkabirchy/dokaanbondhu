<?php
// A decoy: the scanner never opens vendor/ (spec 16.3); this package's route is listed as skipped.

namespace Laravel\Sanctum\Http\Controllers;

class CsrfCookieController
{
    public function show()
    {
        $request->validate(['decoy' => 'required']);
    }
}
