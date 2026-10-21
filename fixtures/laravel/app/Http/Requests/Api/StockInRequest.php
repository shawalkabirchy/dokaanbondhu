<?php

namespace App\Http\Requests\Api;

use Illuminate\Foundation\Http\FormRequest;

class StockInRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'vendor_id' => 'required|integer|exists:suppliers,id',
            'lines' => 'required|array',
            'lines.*.product_id' => 'required|integer|exists:parts,id',
            'lines.*.qty' => 'required|integer|min:1',
            'lines.*.cost' => 'required|integer|min:0',
        ];
    }
}
