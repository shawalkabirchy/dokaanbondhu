<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;

/** A shared parent: a request that extends it without its own rules() uses these. */
abstract class LineRequest extends FormRequest
{
    public function rules(): array
    {
        return [
            'sale_id' => 'required|integer|exists:sales,id',
            'sale_item_id' => 'required|integer|exists:App\Models\SaleItem,id',
            'quantity' => 'required|integer|min:1',
            'reason' => 'nullable|string|max:200',
        ];
    }
}
