<?php

namespace App\Http\Requests;

class StoreReturnRequest extends LineRequest
{
    public function authorize(): bool
    {
        return true;
    }
}
